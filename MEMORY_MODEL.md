# Memory model

AgentOS keeps four kinds of state for an agent: working memory and conversation history (always on, one per GMI), cognitive memory traces (on when a factory builds a manager), the cognitive mechanisms and the observer/reflector pipeline (each behind its own config), and durable storage (on when a brain is attached).

## Working memory and history

Every GMI has an [`InMemoryWorkingMemory`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/memory/InMemoryWorkingMemory.ts) for its mood, user context and task context, and a [`ConversationHistoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/ConversationHistoryManager.ts) that keeps the last 20 messages unless the persona sets `conversationContextConfig.maxMessages`. Both are per instance and live as long as the GMI.

## Cognitive memory

[`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) stores traces of five types, `episodic`, `semantic`, `procedural`, `prospective` and `relational` ([`types.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts)). Each trace is encoded with a strength and a stability computed from the base strength, the current mood's arousal, its emotional intensity, a HEXACO-weighted attention multiplier and a mood-congruence boost ([`EncodingModel`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts)); retrieval ranks candidates by strength, similarity, recency, emotional congruence, graph activation and importance with the default weights in [`RetrievalPriorityScorer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/RetrievalPriorityScorer.ts); each retrieval reinforces the top results ([`DecayModel`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts)). The memory graph is on by default with the knowledge-graph backend, and a pure in-memory graphology backend exists ([`config.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts)).

Three parts are opt-in:

- The eight cognitive mechanisms (reconsolidation, retrieval-induced forgetting, involuntary recall, feeling-of-knowing, temporal gist, schema encoding, source-confidence decay, emotion regulation) run only when the manager is created with a `cognitiveMechanisms` config; an empty object turns all eight on with their defaults.
- The observer and reflector pipeline runs only when `observer.llmInvoker` and `reflector.llmInvoker` are configured.
- Durable storage runs only when a `brain` is attached; without one, traces live in the vector store and the in-process caches.

## Where memory attaches

On the runtime, a GMI receives a cognitive memory manager only when `gmiManagerConfig.cognitiveMemoryFactory` builds one for it ([`GMIManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMIManager.ts)); no default factory exists, so a runtime without one runs GMIs with history and working memory alone. On the lightweight path, [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) takes a `memoryProvider` whose `getContext` is injected before each call and whose `observe` runs after it; [`souledAgent()`](https://github.com/framerslab/agentos/blob/master/src/api/souledAgent.ts) supplies one over a soul workspace's markdown wiki. `agent({ runtime: 'gmi' })` with `memory` set (or `cognition: 'full'`) builds one for its sessions, over an in-memory vector store and knowledge graph, with an embedding model from `memory.embedding` ([GMIs from agent()](./GMI.md#gmis-from-agent)). Products that want the cognitive manager elsewhere build it themselves with its vector store, graph, embedding manager and traits.

## Related pages

[Memory System Overview](./MEMORY_SYSTEM_OVERVIEW.md), [Cognitive Memory](./memory/COGNITIVE_MEMORY.md), [Soul Files](./SOUL_FILES.md), [Generalized Mind Instances](./GMI.md).
