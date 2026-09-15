---
description: "The 26-module AgentOS architecture: API surface, orchestration, GMI cognitive engine, guardrails, tools and extensions, cognitive memory and RAG, LLM providers, perception channels — and how they compose into a runtime that manages state across hours and conversations."
keywords: [agentos architecture, ai agent runtime architecture, agent framework system design, gmi, cognitive memory architecture, multi-agent orchestration]
---

# System Architecture

AgentOS organizes the runtime around long-running agent state rather than around a single turn loop. Cross-session conversations, parallel agent instances with independent personality and memory, conditional tool execution, human-in-the-loop approval, and a memory layer that distinguishes verified user input from model-generated content are first-class subsystems with their own modules.

The 26 top-level modules documented below are predominantly state-management subsystems. The turn loop itself is one component among them, not the central abstraction.

This page is the system map. For the *what* of each subsystem — components, lifecycle ownership, source-tree location — read on. For deep-dives into individual concerns, follow the table of contents.

For specific subsystem deep-dives, see:
- [Provenance & Immutability](../features/provenance-immutability.md)

![AgentOS layered architecture: seven cooperating layers from caller-facing API (generateText, streamText, agent, agency, mission) through cognitive substrate (GMI coordinator, PersonaOverlayManager, SentimentTracker, MetapromptExecutor), memory and RAG (4-tier memory, 8 cognitive mechanisms, HyDE, GraphRAG, 7 vector backends), tools and capabilities (100+ extension packs, 88 SKILL.md modules, runtime tool forging), guardrails and HITL (PII redaction, ML classifiers, NLI grounding, 5 approval triggers), orchestration (workflow, mission, AgentGraph, checkpointing), down to I/O and providers (voice pipeline, channels, media generation, 12 LLM providers, OpenRouter fanout).](/img/diagrams/system-architecture.svg)

Each layer above corresponds to a section below. The mapping is one-to-one: layer 1 → [API Surface Contract](#api-surface-contract), layer 2 → [GMI](#gmi-generalized-mind-instance), layer 3 → [Memory System](#memory-system), layer 4 → [Tools, Skills, Extensions](#tools-skills--extensions), layer 5 → [Safety & Guardrails](#safety--guardrails), layer 6 → [Orchestration](#orchestration), layer 7 → [Perception & Channels](#perception--channels). The component pills inside each layer in the diagram are the same class and function names you'll see in the subsystem write-ups.

---

## Source Directory Layout

The `src/` tree is organized into 26 domain-specific top-level modules. Only foundational infrastructure remains under `core/`.

**Perception model:** Vision, hearing, and speech are separated into three independent modules following the biological perception analogy -- **vision/** (OCR, scene detection, image analysis), **hearing/** (STT providers, VAD, silence detection), and **speech/** (TTS providers, resolver, session). Shared media generation (images, video, music, SFX) remains under **media/**.

**Key architectural patterns:**

- **GMI** (Generalized Mind Instance) delegates to focused collaborators: [`ConversationHistoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/ConversationHistoryManager.ts), [`CognitiveMemoryBridge`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts), [`SentimentTracker`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/SentimentTracker.ts), and [`MetapromptExecutor`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/MetapromptExecutor.ts). Persona layering lives in `cognitive_substrate/persona_overlays/`. Personas can be loaded from JSON (the legacy [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) format) or from `SOUL.md` workspace directories via `SoulLoader` (`cognitive_substrate/personas/SoulLoader.ts`) — both produce the same runtime [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts). See [SOUL_FILES.md](../SOUL_FILES.md) for the per-agent identity convention.

- **AgentOS** is the public lifecycle facade. Setup and runtime concerns are in `api/runtime/` ([`WorkflowFacade`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/WorkflowFacade.ts), [`CapabilityDiscoveryInitializer`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/CapabilityDiscoveryInitializer.ts), [`RagMemoryInitializer`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/RagMemoryInitializer.ts)). High-level helpers (`generateText`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts), [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts), [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts)) live under `api/`.

- **AgentOSOrchestrator** coordinates requests, delegating to [`TurnExecutionPipeline`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/TurnExecutionPipeline.ts) (pre-LLM preparation), [`GMIChunkTransformer`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/GMIChunkTransformer.ts) (stream mapping), and [`ExternalToolResultHandler`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/ExternalToolResultHandler.ts) (tool-result continuation).

All paths below are under [`packages/agentos/src/`](https://github.com/framerslab/agentos/tree/master/src/).

| Module | Subdirs | Purpose |
| --- | --- | --- |
| `agents/` | `definitions/` · `agency/` | Agent type definitions and multi-agent coordination ([`AgencyRegistry`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyRegistry.ts)) |
| `api/` | `runtime/` · `types/` | Public API surface — [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), `generateText`, [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts), [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts), [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts), orchestrator collaborators, provider defaults |
| `channels/` | `adapters/` · `telephony/` · `social-posting/` | Platform adapters (Discord, Slack), voice-call providers (Twilio, Vonage), social-post management |
| `cognitive_substrate/` | `personas/` · `persona_overlays/` | The GMI itself plus [`ConversationHistoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/ConversationHistoryManager.ts), [`CognitiveMemoryBridge`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts), [`SentimentTracker`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/SentimentTracker.ts), [`MetapromptExecutor`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/MetapromptExecutor.ts), and persona loaders (JSON + `SOUL.md` via `SoulLoader`) |
| `core/` | `config/` · `conversation/` · `embeddings/` · `llm/` · `logging/` · `rate-limiting/` · `storage/` · `streaming/` · `tools/` · `utils/` · `vector-store/` | Foundational infrastructure: shared interfaces, the [`IStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentToolRegistry.ts), the [`StreamingManager`](https://github.com/framerslab/agentos/blob/master/src/core/streaming/StreamingManager.ts), the [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) / [`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts), embedding and vector-store abstractions |
| `discovery/` | — | Capability-discovery engine (tiered semantic search) |
| `emergent/` | — | Runtime tool forging and self-improvement (`forge_tool`, [`EmergentCapabilityEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentCapabilityEngine.ts), [`EmergentJudge`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentJudge.ts)) |
| `evaluation/` | `observability/` | Eval framework + OpenTelemetry tracing and metrics |
| `extensions/` | — | Extension system: [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts), descriptor kinds, activation lifecycle |
| `hearing/` | — | Listening surface: STT providers, VAD, silence detection |
| `marketplace/` | `store/` · `workspace/` | Agent-marketplace listings + per-agent workspace helpers |
| `media/` | `audio/` · `images/` · `video/` | Creative generation: image (DALL-E, Stability), video, music, SFX |
| `memory/` | `core/` · `io/facade/` · `io/tools/` · `mechanisms/` · `pipeline/` · `retrieval/` | Cognitive memory system: encoding/decay, the Memory API, memory tools, neuroscience-grounded mechanisms, consolidation, retrieval brain |
| `nlp/` | `ai_utilities/` · `language/` · `tokenizers/` · `stemmers/` · normalizers · lemmatizers · filters | NLP processing — LLM-backed summarization, language detection, tokenizers |
| `orchestration/` | `planner/` · `hitl/` · `workflows/` · `turn-planner/` · `ir/` · `compiler/` · `runtime/` · `checkpoint/` · `events/` | DAG workflow engine, [`PlanningEngine`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/PlanningEngine.ts) (ReAct loops), human-in-the-loop, IR/compiler, event bus |
| `provenance/` | — | Content provenance + blockchain anchoring |
| `query-router/` | — | Query classification + routing |
| `rag/` | `vector-search/` · `vector_stores/` · `chunking/` · `reranking/` · `unified/` · `graphrag/` | Retrieval-augmented generation: HNSW sidecar, vector-store implementations, chunking strategies, reranking, graph-augmented retrieval |
| `safety/` | `guardrails/` · `runtime/` | Guardrails ([`IGuardrailService`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts), [`ParallelGuardrailDispatcher`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/ParallelGuardrailDispatcher.ts)) and runtime safety ([`CircuitBreaker`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CircuitBreaker.ts), [`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts), [`StuckDetector`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/StuckDetector.ts)) |
| `sandbox/` | `executor/` · `subprocess/` | Sandboxed code execution (`node:vm`) and [`CLISubprocessBridge`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLISubprocessBridge.ts) / [`CLIRegistry`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/subprocess/CLIRegistry.ts) |
| `skills/` | — | `SKILL.md` loader (content lives in `agentos-skills`) |
| `speech/` | — | Speaking surface: TTS providers, resolver, session |
| `structured/` | `output/` · `prompting/` | Structured output ([`StructuredOutputManager`](https://github.com/framerslab/agentos/blob/master/src/api/structured/output/StructuredOutputManager.ts), JSON schema) + prompt routing |
| `types/` | — | Shared types (auth) |
| `vision/` | — | Seeing surface: OCR, scene detection, image analysis |
| `voice-pipeline/` | — | Real-time voice-conversation orchestrator |

### Architecture Layers

The diagram at the top of this page is the canonical layered view. From top to bottom:

1. **API surface** — `generateText` / [`streamText`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts) / [`agent`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) / [`agency`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts) / `generateImage`, plus the [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) lifecycle facade.
2. **Orchestration** — DAG runtime, `workflow()`, `mission()`, [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts), HITL, checkpointing, planning engine.
3. **GMI** — per-mind state: `ConversationHistory`, [`CognitiveMemoryBridge`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts), [`SentimentTracker`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/SentimentTracker.ts), [`MetapromptExecutor`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/MetapromptExecutor.ts), persona overlays.
4. **Safety & Guardrails** alongside **Tools & Extensions** — 5-tier security (PII, toxicity, grounding, circuit breakers, cost guard) and the 110-extension / 88-skill catalog with capability discovery and runtime tool forging.
5. **Memory & RAG** — 4-tier cognitive memory, 8 mechanisms (Ebbinghaus decay, retrieval-induced forgetting, …), 7 vector backends, HyDE, GraphRAG, hybrid retrieval, [`CitationVerifier`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/citation/CitationVerifier.ts).
6. **LLM providers** — 11 direct providers + OpenRouter fan-out with automatic fallback chains.
7. **Perception & channels** — vision (OCR), hearing (STT, VAD), speech (TTS, voice pipeline), 12 messaging adapters, telephony.

The diagram above the prose shows how a typical request enters at layer 1 and traverses downward.

### API Surface Contract

`generateText()`, `streamText()`, `agent()`, `agency()`, and the [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) runtime share some configuration names, but the shared config surface does not imply identical enforcement.

- `agent()` is the lightweight stateful facade for prompt assembly, sessions, tools, hooks, personality shaping, and usage-ledger forwarding.
- `generateText()` / `streamText()` are low-level helper loops for provider selection, direct tool execution, and text-fallback tool calling.
- The full `AgentOS` runtime and `agency()` own the deeper runtime systems: emergent tooling, guardrails, discovery, RAG bootstrapping, permissions/security tiers, HITL, voice/channels, and provenance-aware orchestration.

```mermaid
graph TB
    Client[Client / Channel Adapter] --> API[AgentOS.processRequest]
    API --> Auth[Auth & Rate Limiting]
    Auth --> Orch[AgentOSOrchestrator]
    Orch --> TurnPipe[TurnExecutionPipeline]
    TurnPipe --> CtxAssembly[Context Assembly]
    TurnPipe --> MemRetrieve[Memory Retrieval]
    TurnPipe --> PromptBuild[Prompt Construction]
    TurnPipe --> InputGuard[Input Guardrails]
    Orch --> GMI[GMI.processTurnStream]
    GMI --> LLM[LLM Provider]
    LLM --> ToolCall{Tool Call?}
    ToolCall -->|Yes| ToolOrch[ToolOrchestrator]
    ToolOrch --> LLM
    ToolCall -->|No| OutputGuard[Output Guardrails]
    OutputGuard --> Stream[StreamingManager]
    Stream --> Client
```

---

## GMI (Generalized Mind Instance)

GMI is what an agent actually *is* between turns: persona, working memory, mood, reasoning trace, conversation history. Each instance is a single mind bound to one persona. The [dedicated GMI page](./gmi.md) walks the seven-ring concentric model in detail — this section covers how the GMI plugs into the wider runtime.

### GMI Lifecycle

```mermaid
stateDiagram-v2
    [*] --> NEW: constructor
    NEW --> IDLE: bind dependencies
    IDLE --> READY: initialize(persona, config)
    READY --> PROCESSING: processTurnStream()
    PROCESSING --> AWAITING_TOOL_RESULT: tool call
    AWAITING_TOOL_RESULT --> PROCESSING: tool result received
    PROCESSING --> READY: turn complete
```

### Initialization

`GMI.initialize(persona, config)` validates required dependencies, wires collaborators, and loads state:

```typescript
const gmi = new GMI('my-gmi-id');
await gmi.initialize(researchAssistantPersona, {
  workingMemory,
  promptEngine,
  toolOrchestrator,
  llmProviderManager,
  utilityAI,
  cognitiveMemory,       // Optional: enables CognitiveMemoryBridge
  retrievalAugmentor,    // Optional: enables RAG
});
```

Required dependencies: `workingMemory`, `promptEngine`, `toolOrchestrator`, `llmProviderManager`, `utilityAI`. Optional: `cognitiveMemory`, `retrievalAugmentor`.

### Collaborators

The GMI delegates to four extracted collaborators to keep the core class focused:

| Collaborator | Responsibility |
|---|---|
| [`ConversationHistoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/ConversationHistoryManager.ts) | Maintains chat history, supports hydration from external stores |
| `CognitiveMemoryBridge` | Bridges GMI turns to the [`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) (encode/retrieve/observe) |
| `SentimentTracker` | Tracks user sentiment via [`IUtilityAI`](https://github.com/framerslab/agentos/blob/master/src/cognition/nlp/ai_utilities/IUtilityAI.ts), emits [`GMIEvent`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMIEvent.ts) types (frustration, confusion, etc.) |
| `MetapromptExecutor` | Handles metaprompt triggers, self-reflection, and state updates |

### Turn Processing

`processTurnStream()` is an async generator that yields [`GMIOutputChunk`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/IGMI.ts) objects:

```typescript
for await (const chunk of gmi.processTurnStream(turnInput)) {
  switch (chunk.type) {
    case GMIOutputChunkType.TEXT_DELTA:     // Streaming text
    case GMIOutputChunkType.TOOL_CALL:      // Tool call request
    case GMIOutputChunkType.TOOL_RESULT:    // Tool execution result
    case GMIOutputChunkType.FINAL_RESPONSE: // Aggregated final output
    case GMIOutputChunkType.ERROR:          // Error during processing
  }
}
```

### AgentOS Facade

`AgentOS` (`api/AgentOS.ts`) is the public-facing facade that manages GMI instances, streaming, and cross-cutting concerns. It exposes `processRequest()` as the primary entry point and coordinates:

- [`GMIManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMIManager.ts) -- Pool of GMI instances keyed by persona/session
- [`AgentOSOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/AgentOSOrchestrator.ts) -- Turn preparation and stream transformation
- [`StreamingManager`](https://github.com/framerslab/agentos/blob/master/src/core/streaming/StreamingManager.ts) -- WebSocket/SSE stream multiplexing
- [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts) -- Tool, guardrail, and workflow extension loading
- [`ConversationManager`](https://github.com/framerslab/agentos/blob/master/src/core/conversation/ConversationManager.ts) -- Cross-session conversation persistence

[`AgentOSConfig`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) is the comprehensive configuration object (~50 fields) that wires all subsystems together. Key optional features activated via config: `ragConfig`, `turnPlanning`, `emergent`, `observability`, `standaloneMemory`, `workflowEngineConfig`.

---

## Request Lifecycle

A user request flows through the following stages:

1. **Authentication & Rate Limiting** -- Validate auth context and check rate limits.
2. **Context Assembly** -- Load session history, conversation context, and temporal/environmental state.
3. **GMI Selection** -- Get or create a GMI instance for the user/persona/session tuple.
4. **Memory Retrieval** -- `CognitiveMemoryBridge` retrieves relevant memory traces; RAG retrieval runs if configured.
5. **Prompt Construction** -- `MetapromptExecutor` assembles system, persona, memory, RAG context, and conversation history into the prompt via `PromptBuilder`.
6. **Pre-execution Guardrails** -- [`ParallelGuardrailDispatcher`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/ParallelGuardrailDispatcher.ts) runs input guardrails (sanitizers first, classifiers in parallel).
7. **Tool Orchestration** -- [`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts) resolves and executes any tool calls selected by the LLM.
8. **LLM Execution** -- [`StreamingManager`](https://github.com/framerslab/agentos/blob/master/src/core/streaming/StreamingManager.ts) sends the prompt to the selected LLM provider and streams chunks.
9. **Post-execution Guardrails** -- Output guardrails evaluate the response (toxicity, PII, grounding).
10. **Memory Update** -- `CognitiveMemoryBridge` encodes new memory traces; [`MemoryObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) queues background consolidation.
11. **Analytics** -- [`Tracer`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/observability/Tracer.ts) records OpenTelemetry spans; cost/token metrics are tracked.

The [`TurnExecutionPipeline`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/TurnExecutionPipeline.ts) (in `api/runtime/`) handles steps 2-6 before handing off to the LLM. [`GMIChunkTransformer`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/GMIChunkTransformer.ts) maps raw LLM chunks into [`AgentOSResponse`](https://github.com/framerslab/agentos/blob/master/src/api/types/AgentOSResponse.ts) format. [`ExternalToolResultHandler`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/ExternalToolResultHandler.ts) manages tool-result continuation loops.

### Sequence Diagram

The following sequence diagram traces a single request through the system:

```mermaid
sequenceDiagram
    participant C as Client
    participant AOS as AgentOS
    participant Orch as Orchestrator
    participant TP as TurnPipeline
    participant GMI as GMI
    participant GR as Guardrails
    participant LLM as LLM Provider
    participant TO as ToolOrchestrator
    participant Mem as CognitiveMemoryBridge

    C->>AOS: processRequest(input)
    AOS->>Orch: orchestrate(input, sessionId)
    Orch->>TP: prepare(input, context)
    TP->>Mem: assembleForPrompt(query, tokenBudget)
    Mem-->>TP: AssembledMemoryContext
    TP->>GR: evaluateInput(services, input, ctx)
    GR-->>TP: GuardrailInputOutcome
    alt BLOCK
        TP-->>C: Error stream (policy violation)
    end
    TP-->>Orch: PreparedTurn (prompt, tools, memories)
    Orch->>GMI: processTurnStream(turnInput)
    GMI->>LLM: stream(messages, tools)
    loop Tool call loop
        LLM-->>GMI: tool_call chunk
        GMI->>TO: processToolCall(request, context)
        TO-->>GMI: ToolCallResult
        GMI->>LLM: tool_result continuation
    end
    LLM-->>GMI: text chunks
    GMI-->>Orch: GMIOutputChunk stream
    Orch->>GR: wrapOutput(services, stream)
    GR-->>C: Filtered AgentOSResponse stream
    Orch->>Mem: encode(turnContent) [async]
```

### Key Types

| Type | Module | Purpose |
|------|--------|---------|
| [`AgentOSInput`](https://github.com/framerslab/agentos/blob/master/src/api/types/AgentOSInput.ts) | `api/types/` | Normalized request envelope (text, audio, images, metadata) |
| [`AgentOSResponse`](https://github.com/framerslab/agentos/blob/master/src/api/types/AgentOSResponse.ts) | `api/types/` | Streamed response chunks (TEXT_DELTA, TOOL_CALL, FINAL_RESPONSE, ERROR) |
| [`GMITurnInput`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/IGMI.ts) | `cognitive_substrate/IGMI` | Internal turn representation consumed by the GMI |
| [`GMIOutputChunk`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/IGMI.ts) | `cognitive_substrate/IGMI` | Per-chunk output from the cognitive engine |
| [`ConversationContext`](https://github.com/framerslab/agentos/blob/master/src/core/conversation/ConversationContext.ts) | `core/conversation/` | Session state: history, active persona, user context |

---

## Extension & Guardrail Runtime

The extension runtime is centered on three core pieces:

1. **[`ExtensionManifest`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts) / [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts)** -- Declarative loading of tool bundles, guardrails, and channel adapters.
2. **[`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts)** -- Descriptor activation and runtime access.
3. **[`ISharedServiceRegistry`](https://github.com/framerslab/agentos/blob/master/src/extensions/ISharedServiceRegistry.ts)** -- Lazy singleton reuse across packs (for NLP pipelines, ONNX classifiers, embedding functions).

```typescript
interface ExtensionPack {
  name: string;
  version?: string;
  descriptors: ExtensionDescriptor[];
  onActivate?: (context: ExtensionLifecycleContext) => Promise<void> | void;
  onDeactivate?: (context: ExtensionLifecycleContext) => Promise<void> | void;
}
```

### Creating an Extension Pack

Extension packs are the unit of distribution. Each pack bundles one or more descriptors of the same or different kinds (`tool`, `guardrail`, [`workflow`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts), `provenance`, etc.) and can hook into the activation lifecycle to perform setup and teardown.

```typescript
import type { ExtensionPack, ExtensionLifecycleContext } from '@framers/agentos/extensions';
import { EXTENSION_KIND_TOOL } from '@framers/agentos/extensions';

export function createMyExtensionPack(): ExtensionPack {
  return {
    name: 'my-custom-tools',
    version: '1.0.0',
    descriptors: [
      {
        kind: EXTENSION_KIND_TOOL,
        tool: {
          id: 'my-search-tool',
          name: 'search_documents',
          displayName: 'Document Search',
          description: 'Search internal documents by query.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          execute: async (args) => {
            const results = await searchIndex(args.query);
            return { success: true, output: results };
          },
        },
      },
    ],
    onActivate: async (ctx: ExtensionLifecycleContext) => {
      const apiKey = ctx.getSecret?.('MY_API_KEY');
      // Initialize resources, warm caches, etc.
    },
    onDeactivate: async () => {
      // Release resources
    },
  };
}
```

Packs are loaded by including them in the `extensionManifest` passed to `AgentOS.initialize()`, or by using the schema-on-demand meta-tools (`extensions_list`, `extensions_enable`) at runtime.

### Descriptor Kinds

| Kind | Constant | Payload Field | Description |
|------|----------|---------------|-------------|
| `tool` | [`EXTENSION_KIND_TOOL`](https://github.com/framerslab/agentos/blob/master/src/extensions/types.ts) | `tool: ITool` | Callable tool registered in ToolOrchestrator |
| `guardrail` | [`EXTENSION_KIND_GUARDRAIL`](https://github.com/framerslab/agentos/blob/master/src/extensions/types.ts) | `guardrail: IGuardrailService` | Input/output guardrail |
| [`workflow`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts) | [`EXTENSION_KIND_WORKFLOW`](https://github.com/framerslab/agentos/blob/master/src/extensions/types.ts) | `workflow: WorkflowDescriptorPayload` | Reusable workflow definition |
| `provenance` | [`EXTENSION_KIND_PROVENANCE`](https://github.com/framerslab/agentos/blob/master/src/extensions/types.ts) | `provenance: IProvenanceProvider` | Content anchoring provider |

### Guardrail Dispatch Model

[`ParallelGuardrailDispatcher`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/ParallelGuardrailDispatcher.ts) uses a two-phase execution model:

1. **Phase 1 (sequential sanitizers)** -- Guardrails with `config.canSanitize === true` run in registration order and can chain `SANITIZE` results deterministically. A `BLOCK` in Phase 1 short-circuits the entire pipeline.
2. **Phase 2 (parallel classifiers)** -- All remaining guardrails run concurrently via `Promise.allSettled`. A Phase 2 `SANITIZE` is downgraded to `FLAG` because concurrent sanitization would produce non-deterministic results.

The final outcome uses worst-wins aggregation: `BLOCK (3) > FLAG (2) > ALLOW (0)`.

```mermaid
graph LR
    Input[User Input] --> S1[Sanitizer 1<br/>PII Redactor]
    S1 -->|sanitized text| S2[Sanitizer 2<br/>Profanity Filter]
    S2 -->|sanitized text| P[Parallel Phase]
    P --> C1[Classifier 1<br/>Toxicity]
    P --> C2[Classifier 2<br/>Policy Guard]
    P --> C3[Classifier 3<br/>Grounding]
    C1 --> Agg[Worst-Wins<br/>Aggregation]
    C2 --> Agg
    C3 --> Agg
    Agg --> Result[GuardrailInputOutcome]
```

[`GuardrailOutputPayload`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/IGuardrailService.ts) carries `ragSources?: RagRetrievedChunk[]` so grounding-aware guardrails can verify claims against retrieved evidence.

Each guardrail service can also configure timeouts via `config.timeoutMs`. If a guardrail exceeds its timeout or throws, it fails open (returns `null`) rather than blocking the pipeline.

### Built-in Guardrail Packs

Six built-in packs ship from [`packages/agentos-extensions/registry/curated/safety/`](https://github.com/framerslab/agentos-extensions/tree/master/registry/curated/safety):

- `pii-redaction` — sanitizer; redacts personally identifiable information before tokens leave the runtime
- `ml-classifiers` — toxicity / hate-speech / harm classification via on-device ONNX models
- `topicality` — LLM-as-judge classifier that rejects off-topic / out-of-scope prompts
- `code-safety` — static + heuristic detection of dangerous code patterns in agent-emitted snippets
- `grounding-guard` — verifies output claims against retrieved RAG sources (citation faithfulness)
- `content-policy-rewriter` — sanitizer; rewrites policy-violating output in-place rather than blocking

For details on writing custom guardrails, see [Creating Guardrails](../safety/CREATING_GUARDRAILS.md) and [Guardrails Usage](../safety/GUARDRAILS_USAGE.md).

---

## Persona System

Personas define the identity, expertise, and behavioral configuration for a GMI instance.

**Key files:**
- `cognitive_substrate/personas/IPersonaDefinition.ts` -- The [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) interface
- `cognitive_substrate/personas/PersonaLoader.ts` -- Loads persona JSON files from disk or registry
- `cognitive_substrate/personas/PersonaValidation.ts` -- Schema validation
- `cognitive_substrate/persona_overlays/PersonaOverlayManager.ts` -- Runtime persona layering

A persona definition includes:

- **Identity** -- Name, role, title, personality traits, expertise domains, purpose/objectives
- **Cognitive config** -- Memory settings (working memory capacity, decay rate, consolidation frequency), attention priorities
- **Behavioral config** -- Communication style, problem-solving methodology, collaboration style
- **HEXACO personality traits** -- Six-factor personality model that modulates memory encoding, retrieval, and cognitive mechanisms

### HEXACO Trait Modulation

The HEXACO model provides six orthogonal personality dimensions. Each trait modulates specific cognitive subsystems:

| HEXACO Trait | Range | Cognitive Effect |
|---|---|---|
| **Honesty-Humility** | 0-1 | Source confidence skepticism. High H penalizes unverified claims. |
| **Emotionality** | 0-1 | Emotional drift in memory encoding. High E amplifies flashbulb memories. |
| **Extraversion** | 0-1 | Feeling-of-knowing threshold. High X lowers the threshold to share uncertain knowledge. |
| **Agreeableness** | 0-1 | Emotion regulation strategy. High A favors cooperative/supportive responses. |
| **Conscientiousness** | 0-1 | Retrieval-induced forgetting strength. High C enables stronger competitive suppression. |
| **Openness** | 0-1 | Involuntary recall sensitivity and novelty attention. High O increases creative associations. |

### Persona Definition Example

```typescript
const researchAssistant: IPersonaDefinition = {
  id: 'research-assistant',
  name: 'Research Assistant',
  role: 'Academic research aide',
  systemPrompt: 'You are a meticulous research assistant...',
  strengths: ['literature review', 'data analysis', 'citation management'],
  hexaco: {
    honestyHumility: 0.9,   // High source skepticism
    emotionality: 0.3,       // Low emotional bias
    extraversion: 0.5,       // Moderate sharing threshold
    agreeableness: 0.7,      // Cooperative communication
    conscientiousness: 0.9,  // Strong retrieval filtering
    openness: 0.8,           // High novelty attention
  },
  memoryConfig: {
    workingMemoryCapacity: 9,
    consolidationFrequencyMinutes: 15,
    ragConfig: {
      retrievalTriggers: { onUserQuery: true },
    },
  },
  moodAdaptation: { enabled: true, defaultMood: 'NEUTRAL', sensitivityFactor: 0.3 },
  defaultModelId: 'gpt-4o',
  defaultProviderId: 'openai',
};
```

The [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts) supports runtime persona blending -- applying temporary overlays (e.g., "be more formal") on top of the base persona definition without mutating the original.

For preset persona definitions, see `packages/wunderland/presets/`.

---

## Prompt Construction

`MetapromptExecutor` (`cognitive_substrate/MetapromptExecutor.ts`) is the prompt assembly engine. It builds the final LLM prompt from several components and supports three trigger types for metaprompt execution: `turn_interval` (periodic self-reflection), `event_based` (driven by `SentimentTracker` events like frustration or confusion), and `manual` (flags in working memory).

### Prompt Assembly Order

The prompt is assembled in a specific order, with each section receiving a token budget allocation:

```mermaid
flowchart TB
    P1["1 · System Instruction<br/><i>fixed · persona systemPrompt</i>"]:::input
    P2["2 · Persona Overlays<br/><i>variable · active overlays</i>"]:::input
    P3["3 · Memory Context<br/><i>~20% budget · 6 sections from MemoryPromptAssembler</i>"]:::process
    P4["4 · RAG Context<br/><i>~15% budget · retrieved document chunks</i>"]:::process
    P5["5 · Tool Schemas<br/><i>~10% budget or discovery tier</i>"]:::process
    P6["6 · Conversation History<br/><i>remaining tokens · truncate / summarize / hybrid overflow</i>"]:::process
    LLM["LLM prompt"]:::output

    P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> LLM

    classDef input fill:#cffafe,stroke:#0891b2,color:#0e7490
    classDef process fill:#eef2ff,stroke:#6366f1,color:#3730a3
    classDef output fill:#dcfce7,stroke:#10b981,color:#047857
```

### Token Budget Strategy

`ConversationHistoryManager` supports three overflow strategies when conversation history exceeds the allocated token budget:

- **`truncate`** -- Drop oldest messages first (lowest latency, no LLM call)
- **`summarize`** -- Use `IUtilityAI.summarize()` to compress older history into a summary block (triggered at `summarizationTriggerTokens`)
- **`hybrid`** -- Keep recent messages verbatim, summarize older ones (best quality/cost tradeoff)

The total token budget is derived from the model's context window minus reserves for system prompt and output tokens. `PromptProfileRouter` (`structured/prompting/PromptProfileRouter.ts`) can adjust the budget split based on task classification (e.g., RAG-heavy tasks get more retrieval budget).

### Built-in Metaprompt Handlers

MetapromptExecutor includes pre-built handlers for common situations:
- **Frustration recovery** -- Triggered by negative sentiment events
- **Confusion clarification** -- When the user signals misunderstanding
- **Satisfaction reinforcement** -- When the user is pleased
- **Error recovery** -- After tool failures
- **Engagement boost** -- When the conversation stalls
- **Trait adjustment** -- Periodic self-reflection that adjusts persona parameters within bounds

See [Adaptive Prompt Intelligence](../features/adaptive-prompt-intelligence) for the full guide: the three trigger types, the five preset templates, the state surfaces metaprompts mutate, and concrete cost numbers.

---

## Memory System

The cognitive memory system replaces flat key-value memory with a personality-modulated, decay-aware architecture grounded in cognitive science.

### Core Model

Memory traces follow the Ebbinghaus forgetting curve:

```
S(t) = S0 * e^(-dt / stability)
```

where `S0` (initial encoding strength) is set by personality traits, emotional arousal, and content features. The `stability` time constant grows with each successful retrieval via the **desirable difficulty effect** -- memories that were harder to retrieve (lower current strength at retrieval time) receive a larger stability boost.

From `memory/core/decay/DecayModel.ts`:

```typescript
// Ebbinghaus forgetting curve
function computeCurrentStrength(trace: MemoryTrace, now: number): number {
  const elapsed = Math.max(0, now - trace.lastAccessedAt);
  return trace.encodingStrength * Math.exp(-elapsed / trace.stability);
}
```

Traces below a configurable pruning threshold are soft-deleted (`isActive = false`) during consolidation.

### Memory Type Taxonomy

Four memory types (Tulving's taxonomy) across four ownership scopes:

| Type | Description | Example |
|------|-------------|---------|
| `episodic` | Personal experiences and events | "User mentioned they're moving to Berlin on Tuesday" |
| `semantic` | Facts, concepts, general knowledge | "The user's preferred language is Python" |
| `procedural` | How-to knowledge, learned procedures | "When deploying, run tests first, then build, then push" |
| `prospective` | Future intentions and reminders | "Remind user about the deadline next Monday" |

| Scope | Visibility | Shared Across |
|-------|------------|---------------|
| `thread` | Single conversation thread | Nothing |
| `user` | All conversations with one user | Threads |
| `persona` | All users of one persona | Users |
| `organization` | All personas in an org | Personas |

### Architecture

```mermaid
flowchart TB
    CM["CognitiveMemoryManager<br/><i>orchestrator</i>"]:::process
    E["EncodingModel<br/><i>HEXACO weights · flashbulb</i>"]:::process
    D["DecayModel<br/><i>Ebbinghaus · spaced rep · interference</i>"]:::process
    W["CognitiveWorkingMemory<br/><i>Baddeley 7±2 · personality-modulated</i>"]:::process
    M["MemoryStore<br/><i>IVectorStore + IKnowledgeGraph</i>"]:::data
    P["MemoryPromptAssembler<br/><i>6-section token-budgeted assembly</i>"]:::process
    G["IMemoryGraph<br/><i>Graphology · 8 edge types</i>"]:::data
    SA["SpreadingActivation<br/><i>Anderson ACT-R · Hebbian</i>"]:::process
    O["MemoryObserver<br/><i>personality-biased note extraction</i>"]:::process
    R["MemoryReflector<br/><i>LLM consolidates notes → traces</i>"]:::process
    Pr["ProspectiveMemoryManager<br/><i>time / event / context triggers</i>"]:::process
    Co["ConsolidationPipeline<br/><i>5-step periodic maintenance</i>"]:::process

    CM --> E
    CM --> D
    CM --> W
    CM --> M
    CM --> P
    CM --> G
    CM --> SA
    CM --> O
    CM --> R
    CM --> Pr
    CM --> Co

    classDef process fill:#eef2ff,stroke:#6366f1,color:#3730a3
    classDef data fill:#fef3c7,stroke:#f59e0b,color:#92400e
```

### Cognitive Pipeline (per-message smart orchestration)

Above the storage substrate sits an LLM-as-judge orchestration layer that picks strategy per message at three pipeline boundaries. Each stage is its own router primitive — independently shippable, independently testable, composable via the [`CognitivePipeline`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/index.ts) facade. This is **smart orchestration, not safety guardrails** — orchestration picks strategies, guardrails enforce safety/policy at the output stage. They live in different packages on purpose.

```mermaid
flowchart TB
    Content["Content"]:::input
    Q1["Query"]:::input
    Q2["Query"]:::input

    Ingest["IngestRouter<br/><i>input stage</i>"]:::process
    Memory["MemoryRouter<br/><i>recall stage</i>"]:::process
    Read["ReadRouter<br/><i>read stage</i>"]:::process

    State["Memory state"]:::data
    Traces["Retrieved traces"]:::data
    Answer["Final answer"]:::output
    Guard["core/guardrails<br/><i>output validation</i>"]:::external

    Content --> Ingest --> State
    Q1 --> Memory --> Traces
    Q2 --> Read --> Answer --> Guard

    classDef input fill:#cffafe,stroke:#0891b2,color:#0e7490
    classDef process fill:#eef2ff,stroke:#6366f1,color:#3730a3
    classDef data fill:#fef3c7,stroke:#f59e0b,color:#92400e
    classDef output fill:#dcfce7,stroke:#10b981,color:#047857
    classDef external fill:#f3e8ff,stroke:#8b5cf6,color:#5b21b6
```

Every router has the same internal structure: a classifier (LLM-as-judge that maps input to a category/intent token), a pure `select*` function (category + routing table + budget policy → strategy decision), a dispatcher (registry of executors per strategy), and three shipping presets calibrated from LongMemEval-S Phase B N=500 measurements.

| Primitive | Subpath | Categories | Strategies |
|---|---|---|---|
| Memory Router | `@framers/agentos/memory-router` | 6 query categories | 3 backends (canonical-hybrid, OM-v10, OM-v11) |
| Ingest Router | `@framers/agentos/ingest-router` | 6 content kinds | 6 strategies (raw / summarized / observational / fact-graph / hybrid / skip) |
| Read Router | `@framers/agentos/read-router` | 5 read intents | 5 strategies (single-call / two-call extract+answer / commit-vs-abstain / verbatim / scratchpad) |
| Cognitive Pipeline | `@framers/agentos/orchestration/pipeline` | (composition) | wires all three stages |
| Adaptive Memory Router | `@framers/agentos/memory-router` | (self-calibrating) | derives routing tables from your own calibration data |

Each classifier is provider-agnostic — talks to a small `IXClassifierLLM` adapter interface, not an SDK. One OpenAI key reproduces the entire pipeline; no Claude / Gemini accounts required for the shipping configuration.

Each router ships 26-38 contract tests; the entire family ships 163 tests. See the dedicated [Cognitive Pipeline](../COGNITIVE_PIPELINE.md) guide for the unified architecture overview, or the per-stage docs ([Memory Router](../MEMORY_ROUTER.md), [Ingest Router](../INGEST_ROUTER.md), [Read Router](../READ_ROUTER.md), [Adaptive Memory Router](../ADAPTIVE_MEMORY_ROUTER.md)) for the routing tables and presets each stage exposes.

### The MemoryTrace Envelope

Every memory is stored as a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts) (defined in `memory/core/types.ts`):

```typescript
interface MemoryTrace {
  id: string;
  type: MemoryType;                    // episodic | semantic | procedural | prospective
  scope: MemoryScope;                  // thread | user | persona | organization
  content: string;                     // The memory content
  entities: string[];                  // Extracted entity references
  tags: string[];                      // Classification tags
  provenance: MemoryProvenance;        // Source type, confidence, verification count
  emotionalContext: EmotionalContext;   // PAD model: valence, arousal, dominance
  encodingStrength: number;            // S0: initial strength at creation
  stability: number;                   // Time constant (ms), grows with retrieval
  retrievalCount: number;              // Successful retrieval count
  lastAccessedAt: number;              // Unix ms of last access
  reinforcementInterval: number;       // Spaced repetition interval (ms)
  associatedTraceIds: string[];        // Graph linkage to related traces
  isActive: boolean;                   // Soft-delete flag
}
```

### Retrieval Scoring

Retrieval combines six weighted signals to rank candidate traces:

| Signal | Weight | Source |
|--------|--------|--------|
| Strength/decay | 0.25 | `computeCurrentStrength()` from DecayModel |
| Vector similarity | 0.35 | Cosine similarity from IVectorStore |
| Recency | 0.10 | Inverse time since last access |
| Emotional congruence | 0.15 | PAD distance between current mood and encoding mood |
| Graph activation | 0.10 | Spreading activation score from IMemoryGraph |
| Importance | 0.05 | Normalized salience score |

### Eight Cognitive Mechanisms

Located in `memory/mechanisms/`, each mechanism is HEXACO-modulated:

| Mechanism | HEXACO Modulator | Effect |
|-----------|-----------------|--------|
| Reconsolidation | Emotionality | Memories become labile during retrieval; high E increases drift |
| Retrieval-induced forgetting | Conscientiousness | Retrieving one trace suppresses competitors; high C strengthens suppression |
| Involuntary recall | Openness | Spontaneous memory surfacing; high O increases trigger sensitivity |
| Feeling-of-knowing | Extraversion | Metacognitive confidence judgment; high X lowers sharing threshold |
| Temporal gist extraction | Conscientiousness | Compresses episodic details into semantic gist over time |
| Schema encoding | Openness | Assimilates new information into existing knowledge schemas |
| Source confidence decay | Honesty-Humility | Provenance confidence degrades over time; high H accelerates skepticism |
| Emotion regulation | Agreeableness | Modulates emotional coloring of retrieved memories |

### GMI Integration

1. **After user message**: `CognitiveMemoryBridge.encode()` creates a MemoryTrace with personality-modulated strength
2. **Before prompt construction**: `assembleForPrompt()` retrieves and formats memory within a token budget
3. **After response**: [`MemoryObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) feeds the response to the observer buffer for background consolidation

For full details, see [Cognitive Memory](../memory/COGNITIVE_MEMORY.md) (theory + mechanism implementation reference) and the [Memory System Overview](../MEMORY_SYSTEM_OVERVIEW.md) (composition, archive, vendor comparison).

---

## RAG System

The RAG subsystem provides retrieval-augmented generation with multiple vector backends and retrieval strategies.

Runtime truth: the default AgentOS bootstrap path still wires [`EmbeddingManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/EmbeddingManager.ts) -> [`VectorStoreManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/VectorStoreManager.ts) -> [`RetrievalAugmentor`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/RetrievalAugmentor.ts). [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts) is implemented as a higher-level orchestration layer, but it remains opt-in rather than the default runtime path.

### Retrieval Pipeline

```mermaid
graph LR
    Q[User Query] --> HyDE[HyDE Generator<br/>Optional]
    HyDE --> Embed[Embedding<br/>Manager]
    Q --> BM25[BM25 Sparse<br/>Index]
    Embed --> VS[Vector Store<br/>ANN Search]
    VS --> Fusion[Reciprocal Rank<br/>Fusion]
    BM25 --> Fusion
    Fusion --> Rerank[Reranker<br/>Optional]
    Rerank --> Chunks[Top-K Chunks]
    Chunks --> Prompt[Prompt<br/>Assembly]
```

The GMI integrates with RAG through persona-configurable hooks:
- `shouldTriggerRAGRetrieval()` checks `ragConfig.retrievalTriggers` (on user query, on tool failure, on intent detection)
- `retrievalAugmentor.retrieveContext()` runs the default runtime retrieval pipeline
- `performPostTurnIngestion()` summarizes and embeds conversation turns

When a host explicitly wires `QueryRouter.setUnifiedRetriever(...)`, plan-aware retrieval can run through [`UnifiedRetriever`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/unified/UnifiedRetriever.ts) instead of the legacy dispatcher path. That path is real, but not the default bootstrap today.

Within the default QueryRouter path, `cacheResults` now provides in-memory `route()` result caching, and `verifyCitations` can attach `QueryResult.grounding` by running [`CitationVerifier`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/citation/CitationVerifier.ts) over retrieved chunks when embeddings are available.

### Vector Store Backends

Seven [`IVectorStore`](https://github.com/framerslab/agentos/blob/master/src/core/vector-store/IVectorStore.ts) implementations provide different tradeoffs:

| Backend | Latency (100K docs) | Persistence | Best For |
|---------|---------------------|-------------|----------|
| [`HnswlibVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/HnswlibVectorStore.ts) | 2-10ms (ANN) | File-based | Production (self-hosted) |
| [`InMemoryVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/InMemoryVectorStore.ts) | 10-50ms (linear scan) | None | Development / testing |
| [`PostgresVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/PostgresVectorStore.ts) | 5-20ms (pgvector) | PostgreSQL | Production (SQL-native) |
| [`QdrantVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/QdrantVectorStore.ts) | 5-15ms (API) | Managed/self-hosted | Default OSS production |
| [`PineconeVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/PineconeVectorStore.ts) | 20-50ms (API) | Managed cloud | Optional vendor-managed scale |
| `SqliteVectorStore` | 10-30ms | SQLite file | Edge / embedded |
| `IndexedDBVectorStore` | 20-80ms | Browser | Client-side apps |

### Retrieval Strategies

| Strategy | Method | Tradeoff |
|----------|--------|----------|
| **Dense only** | Embedding cosine similarity | Fast, good for semantic match |
| **Sparse only** | BM25 keyword matching | Precise term matching, no semantic understanding |
| **Hybrid** | Dense + Sparse with reciprocal rank fusion | Best recall, slightly higher latency |
| **HyDE** | Generate hypothetical answer, embed that | Better recall for vague queries, extra LLM call |
| **GraphRAG** | Entity graph + community summaries | Best for multi-hop reasoning, highest setup cost |

### GraphRAG Engine

[`GraphRAGEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/graphrag/GraphRAGEngine.ts) (`rag/graphrag/GraphRAGEngine.ts`) implements Microsoft GraphRAG-inspired retrieval:

1. **Ingestion**: Entity extraction (LLM or pattern-based) -> graph construction (graphology) -> Louvain community detection -> hierarchical meta-graph -> LLM community summarization
2. **Global search**: Query community summary embeddings, synthesize across matched communities
3. **Local search**: Query entity embeddings, 1-hop graph expansion, include community context

### Chunking Strategies

Multiple strategies in `rag/chunking/`:
- **Fixed-size** -- Split by token count with configurable overlap
- **Semantic** -- Split at paragraph/section boundaries
- **Recursive** -- Hierarchical splitting (headers -> paragraphs -> sentences)
- **Code-aware** -- Split at function/class boundaries for source code

### Reranking

Pluggable providers in `rag/reranking/`:
- **Cohere API** -- Cloud-hosted cross-encoder
- **Transformers.js** -- Local cross-encoder ONNX model (no API calls)

For configuration details, see [RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md) and [HyDE Retrieval](../memory/HYDE_RETRIEVAL.md).

---

## Multi-Agent Coordination

### Agency System

The agency system enables multi-agent coordination across six strategies (defined in [`AgencyStrategy`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) in [`src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts)):

| Strategy | Behavior |
|---|---|
| `sequential` | Each agent runs after the previous one completes; output of one feeds the next |
| `parallel` | All agents run concurrently against the same input; results are aggregated |
| `debate` | Agents critique and refine each other's outputs across multiple rounds |
| `review-loop` | One agent produces, another reviews; loop continues until reviewer accepts or `maxRounds` |
| `hierarchical` | A coordinator agent delegates to sub-agents and synthesizes their results |
| `graph` | Explicit DAG via `dependsOn` on each sub-agent; runs roots first, then dependents |

Coordination state lives in three classes under [`src/agents/agency/`](https://github.com/framerslab/agentos/tree/master/src/agents/agency):

- [`AgencyRegistry`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyRegistry.ts) — tracks active agencies and the GMIs they contain
- [`AgencyMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgencyMemoryManager.ts) — shared memory across the agency's GMIs (separate from each GMI's private cognitive memory)
- [`AgentCommunicationBus`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgentCommunicationBus.ts) — the message channel GMIs use to coordinate

### Workflow DAG

The orchestration engine compiles workflow definitions into directed acyclic graphs for parallel execution:

```mermaid
graph TD
    Start[Start] --> A[Task A: Research]
    Start --> B[Task B: Data Collection]
    A --> C[Task C: Analysis]
    B --> C
    C --> D[Task D: Report]
    D --> Review{HITL Review}
    Review -->|Approved| End[End]
    Review -->|Rejected| C
```

Workflow definitions live in `orchestration/workflows/` with these key types:
- [`WorkflowDefinition`](https://github.com/framerslab/agentos/blob/master/src/orchestration/workflows/WorkflowTypes.ts) -- The declarative task graph
- [`WorkflowInstance`](https://github.com/framerslab/agentos/blob/master/src/orchestration/workflows/WorkflowTypes.ts) -- A running execution with state
- [`IWorkflowStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/workflows/storage/IWorkflowStore.ts) -- Persistence interface (in-memory default, SQL optional)

The compiler in `orchestration/compiler/` resolves task dependencies, detects cycles, and produces a topologically-sorted execution plan. The runtime in `orchestration/runtime/` executes tasks with configurable parallelism.

### Agent Communication Bus

[`AgentCommunicationBus`](https://github.com/framerslab/agentos/blob/master/src/agents/agency/AgentCommunicationBus.ts) (`agents/agency/AgentCommunicationBus.ts`) provides structured messaging between GMIs:
- **Direct send** -- Targeted messages to specific agents
- **Broadcast** -- Send to all agents in an agency
- **Request/Response** -- Query agents and await responses
- **Handoff** -- Transfer context between agents with state, findings, and memory references

Message types: `task_delegation`, `status_update`, `question`, `answer`, `finding`, `decision`, `critique`, `handoff`, `alert`, `proposal`, `agreement`, `disagreement`.

### Planning Engine

[`PlanningEngine`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/PlanningEngine.ts) (`orchestration/planner/PlanningEngine.ts`) converts high-level goals into multi-step [`ExecutionPlan`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/IPlanningEngine.ts) objects using the ReAct (Reasoning and Acting) pattern. Supports plan generation, task decomposition, plan refinement, and autonomous plan-execute-reflect loops.

### Human-in-the-Loop

[`HumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) (`orchestration/hitl/HumanInteractionManager.ts`) provides structured collaboration between AI agents and human operators:
- **Approval requests** for high-risk actions (with severity levels and reversibility flags)
- **Clarification requests** for ambiguous situations
- **Escalations** for transferring control to humans

The [`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts) integrates HITL directly: tools declaring side effects can be gated through `hitlManager` before execution, with configurable `approvalTimeoutMs` and auto-approve fallback.

### Using the API

```typescript
import { agency } from '@framers/agentos';

// Hierarchical agency with runtime agent synthesis. The manager LLM gets
// delegate_to_<name> tools for each static agent plus a spawn_specialist
// tool that lets it mint new specialists for sub-tasks the static roster
// doesn't cover. EmergentAgentForge validates each spec; EmergentAgentJudge
// gates it on safety/scope/risk before activation.
const research = agency({
  provider: 'openai', model: 'gpt-4o',
  agents: {
    researcher: { instructions: 'Find authoritative sources and pull verbatim quotes.' },
    writer: { instructions: 'Write clear, well-cited prose.' },
  },
  strategy: 'hierarchical',
  emergent: {
    enabled: true,
    judge: true,
    planner: { maxSpecialists: 3, requireJustification: true },
  },
});

const result = await research.generate(
  'Research and summarize recent advances in retrieval-augmented generation.',
);
```

See [Emergent Capabilities](../features/emergent-capabilities.md) for the full worked example of multi-GMI synthesis via `spawn_specialist`, runtime sequence, and tested rejection paths.

### Checkpoint/Restore

The orchestration engine supports checkpointing for long-running workflows via [`ICheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts) (`orchestration/checkpoint/`). Checkpoints capture the full execution state (completed tasks, pending tasks, intermediate results) and support fork/resume semantics -- you can snapshot a workflow at any point and resume it later, or fork from a checkpoint to explore alternative execution paths.

[`InMemoryCheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/InMemoryCheckpointStore.ts) ships as the default implementation; persistent stores can be plugged in via the [`ICheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts) interface.

For details, see [Planning Engine](../orchestration/PLANNING_ENGINE.md), [HITL](../safety/HUMAN_IN_THE_LOOP.md), [Agency API](../orchestration/AGENCY_API.md), and [Agent Communication](./AGENT_COMMUNICATION.md).

---

## Tool System

`ToolOrchestrator` (`core/tools/ToolOrchestrator.ts`) manages tool registration, discovery, permission enforcement, and execution. It acts as a facade over [`ToolPermissionManager`](https://github.com/framerslab/agentos/blob/master/src/core/tools/permissions/ToolPermissionManager.ts) and [`ToolExecutor`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolExecutor.ts).

### ITool Interface

Every tool implements the [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) interface (`core/tools/ITool.ts`):

```typescript
interface ITool<TInput = any, TOutput = any> {
  readonly id: string;              // Globally unique ID (e.g. "web-search-v1")
  readonly name: string;            // LLM-facing name (e.g. "search_web")
  readonly displayName: string;     // Human-readable title
  readonly description: string;     // Detailed description for LLM tool selection
  readonly inputSchema: JSONSchemaObject;   // JSON Schema for arguments
  readonly outputSchema?: JSONSchemaObject; // Optional output schema
  readonly requiredCapabilities?: string[]; // Permission requirements
  readonly category?: string;              // Grouping (e.g. "data_analysis")
  readonly hasSideEffects?: boolean;       // Triggers HITL gating when true

  execute(
    args: TInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<TOutput>>;
}
```

### Custom Tool Example

```typescript
import type { ITool, ToolExecutionResult, ToolExecutionContext } from '@framers/agentos/core/tools/ITool';

const weatherTool: ITool = {
  id: 'weather-lookup-v1',
  name: 'get_weather',
  displayName: 'Weather Lookup',
  description: 'Get current weather for a city. Use when the user asks about weather conditions.',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' },
    },
    required: ['city'],
  },
  hasSideEffects: false,
  async execute(args: { city: string; units?: string }, ctx: ToolExecutionContext) {
    const data = await fetchWeatherAPI(args.city, args.units);
    return { success: true, output: data };
  },
};
```

### Tool Execution Flow

1. LLM emits a `tool_call` chunk with name and arguments
2. `ToolOrchestrator` resolves the tool by name from its registry
3. [`ToolPermissionManager`](https://github.com/framerslab/agentos/blob/master/src/core/tools/permissions/ToolPermissionManager.ts) checks persona capabilities and user subscription
4. If `hasSideEffects` and HITL is enabled, [`HumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) gates the execution
5. [`ToolExecutor`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolExecutor.ts) validates arguments against `inputSchema` and calls `execute()`
6. Result is formatted as [`ToolCallResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/IGMI.ts) and fed back to the LLM

### Capability Discovery

The [`CapabilityDiscoveryEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/discovery/CapabilityDiscoveryEngine.ts) (`discovery/`) replaces static tool schema dumps in the prompt with a three-tier semantic search system, reducing tool-related tokens by ~90%:

| Tier | Content | Token Cost | When Used |
|------|---------|------------|-----------|
| Tier 0 | Category summaries | ~150 tokens | Always included in system prompt |
| Tier 1 | Top-5 semantic matches | ~200 tokens | Per-turn, based on user query |
| Tier 2 | Full JSON schemas | ~1,500 tokens | On-demand via `discover_capabilities` meta-tool |

The engine pipeline: `User Message -> CapabilityIndex.search() -> CapabilityGraph.rerank() -> CapabilityContextAssembler.assemble() -> CapabilityDiscoveryResult`.

### Extension-Provided Tools

Tools are typically loaded via [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts) descriptors. The extension registry catalogs 23+ tools, 37 channels, 3 voice extensions, and 4 orchestration tools.

For details, see [Tool Calling & Loading](../extensions/TOOL_CALLING_AND_LOADING.md) and [Capability Discovery](../extensions/CAPABILITY_DISCOVERY.md).

---

## Guardrails

### GuardrailAction Enum

Four possible outcomes from any guardrail evaluation:

```typescript
enum GuardrailAction {
  ALLOW    = 'allow',     // Pass through unchanged
  FLAG     = 'flag',      // Pass through, record metadata for audit
  SANITIZE = 'sanitize',  // Replace content with modified version
  BLOCK    = 'block',     // Reject / terminate the interaction
}
```

### IGuardrailService Interface

```typescript
interface IGuardrailService {
  config?: {
    evaluateStreamingChunks?: boolean;  // Evaluate during streaming
    maxStreamingEvaluations?: number;   // Rate limit per stream
    canSanitize?: boolean;              // Runs in Phase 1 (sequential)
    timeoutMs?: number;                 // Per-evaluation timeout
  };
  evaluateInput?(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null>;
  evaluateOutput?(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
```

### Five Security Tiers

Security tiers define preset guardrail configurations for different deployment contexts:

| Tier | Name | Input Guardrails | Output Guardrails | Use Case |
|------|------|------------------|-------------------|----------|
| 1 | `dangerous` | None | None | Internal development only |
| 2 | `permissive` | PII redaction | Basic toxicity | Internal tools, trusted users |
| 3 | `balanced` | PII + toxicity | Toxicity + grounding | General-purpose deployment |
| 4 | `strict` | PII + toxicity + policy | Full suite | Customer-facing products |
| 5 | `paranoid` | All + custom validators | All + streaming evaluation | Regulated industries (healthcare, finance) |

### Custom Guardrail Example

```typescript
import { GuardrailAction, type IGuardrailService } from '@framers/agentos/safety/guardrails';

const domainRestrictionGuard: IGuardrailService = {
  config: { canSanitize: false, timeoutMs: 1000 },
  async evaluateInput({ input, context }) {
    const text = input.textInput ?? '';
    if (text.match(/\b(stock|invest|trade)\b/i)) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Financial advice is outside this agent\'s scope.',
        reasonCode: 'DOMAIN_RESTRICTION',
      };
    }
    return { action: GuardrailAction.ALLOW };
  },
};
```

`ParallelGuardrailDispatcher` runs guardrails in two phases (sanitizers sequentially, classifiers in parallel). The safety runtime also includes [`CircuitBreaker`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CircuitBreaker.ts), [`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts), and [`StuckDetector`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/StuckDetector.ts) in `safety/runtime/`.

For details, see [Safety Primitives](../safety/SAFETY_PRIMITIVES.md), [Creating Guardrails](../safety/CREATING_GUARDRAILS.md), and [Guardrails Usage](../safety/GUARDRAILS_USAGE.md).

---

## Voice Pipeline

The real-time voice conversation pipeline lives in `voice-pipeline/` and is orchestrated by [`VoicePipelineOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/VoicePipelineOrchestrator.ts), a state machine that coordinates audio capture, speech recognition, endpoint detection, agent inference, text-to-speech synthesis, and barge-in handling.

### State Machine

```
IDLE -------> startSession() ---------> LISTENING
LISTENING --> turn_complete ----------> PROCESSING
PROCESSING -> LLM tokens start -------> SPEAKING
SPEAKING ---> TTS flush_complete -----> LISTENING
SPEAKING ---> barge-in (cancel) ------> INTERRUPTING -> LISTENING
ANY --------> transport disconnect ---> CLOSED
ANY --------> stopSession() ----------> CLOSED
```

### Component Wiring

```mermaid
graph LR
    Mic[Microphone<br/>AudioFrame] --> Transport[IStreamTransport<br/>WebSocket / WebRTC]
    Transport --> STT[IStreamingSTT<br/>Deepgram / Whisper]
    STT --> EP[IEndpointDetector<br/>Heuristic / Acoustic]
    EP -->|turn_complete| Agent[Agent Session<br/>GMI Turn]
    Agent -->|text chunks| TTS[IStreamingTTS<br/>OpenAI / ElevenLabs]
    TTS -->|EncodedAudioChunk| Transport
    Transport --> Speaker[Speaker]
    STT -.->|speech_detected<br/>during SPEAKING| Bargein[IBargeinHandler<br/>HardCut / SoftFade]
    Bargein -.->|cancel TTS| TTS
```

### Provider Interfaces

| Interface | Purpose | Implementations |
|-----------|---------|-----------------|
| [`IStreamTransport`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Bidirectional audio/text transport | [`WebSocketStreamTransport`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/WebSocketStreamTransport.ts), [`WebRTCStreamTransport`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/WebRTCStreamTransport.ts) |
| [`IStreamingSTT`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Speech-to-text recognition | Deepgram, Whisper, Google, Azure, browser WebSpeechAPI |
| [`IStreamingTTS`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Text-to-speech synthesis | OpenAI TTS, ElevenLabs, Google, Azure, PlayHT |
| [`IEndpointDetector`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Detect when the user finishes speaking | [`HeuristicEndpointDetector`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/HeuristicEndpointDetector.ts), [`AcousticEndpointDetector`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/AcousticEndpointDetector.ts) |
| [`IBargeinHandler`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Handle user interruptions during playback | [`HardCutBargeinHandler`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/HardCutBargeinHandler.ts), [`SoftFadeBargeinHandler`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/SoftFadeBargeinHandler.ts) |
| [`IDiarizationEngine`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) | Multi-speaker identification | (optional, provider-specific) |

### Audio Types

- [`AudioFrame`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) -- Raw PCM audio (Float32Array samples, sampleRate, timestamp). Typically 20ms frames at 16 kHz for STT.
- [`EncodedAudioChunk`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/types.ts) -- Compressed output (Buffer, format: `pcm`/`mp3`/`opus`, durationMs, text). Carries the synthesized text for barge-in tracking.

A watchdog timer prevents the pipeline from staying in LISTENING indefinitely if the user walks away (default 30s, resets after each completed turn).

For details, see [Voice Pipeline](../features/VOICE_PIPELINE.md) and [Speech Providers](../features/SPEECH_PROVIDERS.md).

---

## Channels

Twelve messaging adapters live in `src/channels/adapters/`, plus four telephony providers in `src/channels/telephony/providers/` (Twilio, Telnyx, Plivo, plus a mock for tests). Additional social-platform adapters ship as separate extension packs in [`packages/agentos-extensions/registry/curated/channels/`](https://github.com/framerslab/agentos-extensions/tree/master/registry/curated/channels). Each adapter implements the [`IChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/IChannelAdapter.ts) interface and is loaded as an `ExtensionPack`.

### Platform Table

In-tree messaging adapters (`src/channels/adapters/`):

| Platform | Adapter | Category |
|----------|---------|----------|
| Discord | [`DiscordChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/DiscordChannelAdapter.ts) | Messaging |
| Slack | [`SlackChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/SlackChannelAdapter.ts) | Messaging |
| Telegram | [`TelegramChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/TelegramChannelAdapter.ts) | Messaging |
| WhatsApp | [`WhatsAppChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/WhatsAppChannelAdapter.ts) | Messaging |
| Twitter/X | [`TwitterChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/TwitterChannelAdapter.ts) | Social |
| Reddit | [`RedditChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/RedditChannelAdapter.ts) | Social |
| Signal | [`SignalChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/SignalChannelAdapter.ts) | Messaging |
| IRC | [`IRCChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/IRCChannelAdapter.ts) | Messaging |
| WebChat | [`WebChatChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/WebChatChannelAdapter.ts) | Web |
| Teams | [`TeamsChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/TeamsChannelAdapter.ts) | Enterprise |
| Google Chat | [`GoogleChatChannelAdapter`](https://github.com/framerslab/agentos/blob/master/src/io/channels/adapters/GoogleChatChannelAdapter.ts) | Enterprise |

Telephony (`src/channels/telephony/providers/`): Twilio, Telnyx, Plivo. Additional social-platform adapters (LinkedIn, Bluesky, Mastodon, Threads, etc.) ship as extension packs in [`packages/agentos-extensions/registry/curated/channels/`](https://github.com/framerslab/agentos-extensions/tree/master/registry/curated/channels) rather than in-tree.

### Channel Routing

```typescript
import { ChannelRouter } from '@framers/agentos/channels';

const router = new ChannelRouter();
router.register('telegram', telegramAdapter);
router.register('discord', discordAdapter);

// Route an inbound message to the appropriate adapter
const response = await router.route(inboundMessage);
```

### Social Posting

[`SocialPostManager`](https://github.com/framerslab/agentos/blob/master/src/io/channels/social-posting/SocialPostManager.ts) and [`ContentAdaptationEngine`](https://github.com/framerslab/agentos/blob/master/src/io/channels/social-posting/ContentAdaptationEngine.ts) (in `channels/social-posting/`) handle cross-platform publishing. The adaptation engine reformats content for each platform's constraints (character limits, media formats, hashtag conventions).

Orchestration tools in `tools/`: `multi-channel-post`, `social-analytics`, `media-upload`, `bulk-scheduler`.

For details, see [Channels](../features/CHANNELS.md), [Social Posting](../features/SOCIAL_POSTING.md), and [Telephony Providers](../features/TELEPHONY_PROVIDERS.md).

---

## Observability

AgentOS provides opt-in observability through OpenTelemetry integration, configured via [`AgentOSObservabilityConfig`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/observability/otel.ts).

### Tracing

When `observability.tracing.enabled` is true, AgentOS creates spans for:
- Agent turns (`agentos.turn`)
- Tool executions (`agentos.tool.{name}`)
- Guardrail evaluations (`agentos.guardrail.{phase}`)
- LLM calls (`agentos.llm.completion`)
- Memory retrieval (`agentos.memory.retrieve`)

The [`Tracer`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/observability/Tracer.ts) class (`evaluation/observability/Tracer.ts`) wraps `@opentelemetry/api` and uses the configured tracer name (default `"@framers/agentos"`). Trace context is propagated through [`AgentOSResponse`](https://github.com/framerslab/agentos/blob/master/src/api/types/AgentOSResponse.ts) metadata when `includeTraceInResponses` is enabled, allowing client-side correlation.

### Metrics

When `observability.metrics.enabled` is true, AgentOS exports:
- `agentos.turn.duration_ms` -- Histogram of turn latencies
- `agentos.turn.tokens` -- Counter of prompt/completion tokens
- `agentos.tool.invocations` -- Counter by tool name and outcome
- `agentos.guardrail.evaluations` -- Counter by guardrail name and action

### Logging

[`PinoLogger`](https://github.com/framerslab/agentos/blob/master/src/core/logging/PinoLogger.ts) injects `trace_id` and `span_id` fields when `observability.logging.includeTraceIds` is true. Optional `exportToOtel` emits `LogRecord` objects via `@opentelemetry/api-logs`.

### Evaluation Framework

[`Evaluator`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/Evaluator.ts) and [`LLMJudge`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/LLMJudge.ts) (`evaluation/`) provide a grading framework for agent outputs. [`SqlTaskOutcomeTelemetryStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/turn-planner/SqlTaskOutcomeTelemetryStore.ts) persists per-turn outcome KPI windows so rolling quality metrics survive restarts.

For details, see [Observability](../observability/OBSERVABILITY.md), [Logging](../observability/LOGGING.md), and [Evaluation Framework](../observability/EVALUATION_FRAMEWORK.md).

---

## Emergent Capabilities

The `emergent/` module enables agents to create new tools at runtime within safety bounds.

### SandboxedToolForge

When `emergent: true` is set in [`AgentOSConfig`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), the agent gains access to the `forge_tool` meta-tool. The forge pipeline works as follows:

1. The agent generates JavaScript code for a new tool (name, description, input schema, implementation)
2. [`SandboxedToolForge`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SandboxedToolForge.ts) performs static validation, rejecting dangerous patterns (`eval`, `Function`, `process`, `require`, `import`, `child_process`, `fs.write*`)
3. Validated code executes in a hardened node:vm sandbox via [`CodeSandbox`](https://github.com/framerslab/agentos/blob/master/src/safety/sandbox/executor/CodeSandbox.ts) with configurable bounds:
   - Memory: observed as a heap delta only, not preemptively capped
   - Timeout: 5,000 ms default
   - API allowlist: only `fetch` (domain-restricted), `fs.readFile` (path-restricted, 1 MB max), `crypto` (hash/HMAC only)
4. [`EmergentJudge`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentJudge.ts) evaluates the tool against safety criteria before permanent registration
5. [`EmergentToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentToolRegistry.ts) persists approved tools via [`IStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentToolRegistry.ts)

### Additional Emergent Tools

- [`ComposableToolBuilder`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/ComposableToolBuilder.ts) -- Declarative tool composition by chaining existing tools
- [`AdaptPersonalityTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts) / [`PersonalityMutationStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts) -- Controlled personality adaptation within safety bounds (bounded parameter ranges, mutation logging)
- [`SelfEvaluateTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts) -- Agent self-assessment using LLM-as-judge

For details, see [Emergent Capabilities](./EMERGENT_CAPABILITIES.md) and [Recursive Self-Building Agents](./RECURSIVE_SELF_BUILDING_AGENTS.md).
