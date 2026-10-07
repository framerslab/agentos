# The turn lifecycle

One request to the full runtime becomes one GMI turn. Five stages own it, in this order; every line names the code that runs it.

| Stage | Owner | What happens |
|---|---|---|
| 1. Facade | [`AgentOS.processRequest()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) | Validates the input and evaluates the input guardrails through [`evaluateInputGuardrails`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/guardrailDispatcher.ts). Authentication and rate limiting belong to the host; the facade's own auth calls are commented out. |
| 2. Orchestrator | [`AgentOSOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/AgentOSOrchestrator.ts) | Registers the stream and runs the preparation pipeline, then the GMI turn, and converts the result. |
| 3. Preparation | [`TurnExecutionPipeline.prepareTurn()`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/TurnExecutionPipeline.ts) | Twelve phases: input validation, GMI acquisition ([`GMIManager.getOrCreateGMIForSession()`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMIManager.ts)), stream context, GMI input construction, turn planning, adaptive execution policies, organization context and long-term memory policy, inbound message persistence, rolling summary compaction, prompt profile routing, long-term memory retrieval, and history assembly with metadata persistence. |
| 4. The GMI turn | [`GMI.processTurnStream()`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/GMI.ts) | Sentiment scoring when the persona enables it; the RAG trigger; memory context from [`CognitiveMemoryBridge`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts) when cognitive memory is attached; the prompt from the [`PromptEngine`](https://github.com/framerslab/agentos/blob/master/src/core/llm/PromptEngine.ts); the streaming model call; the tool loop through [`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts), five iterations by default; history and memory updates; the metaprompts. |
| 5. Delivery | [`GMIChunkTransformer`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/GMIChunkTransformer.ts), [`wrapOutputGuardrails`](https://github.com/framerslab/agentos/blob/master/src/safety/guardrails/guardrailDispatcher.ts), [`StreamingManager`](https://github.com/framerslab/agentos/blob/master/src/core/streaming/StreamingManager.ts) | GMI chunks become response chunks, the output guardrails evaluate them, and the streaming manager hands them to the subscribed clients. |

## What a GMI emits

`TEXT_DELTA` for streamed text, `TOOL_CALL_REQUEST` when the model asks for a tool, `USAGE_UPDATE` with token counts, `REASONING_STATE_UPDATE`, `SYSTEM_MESSAGE`, `RAG_SOURCES_AVAILABLE`, a `FINAL_RESPONSE_MARKER`, or `ERROR` ([`IGMI.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/IGMI.ts)). The transformer maps them to `AgentOSResponseChunkType` values; an error anywhere in the turn ends the stream with an `ERROR` chunk whose code is `GMI_PROCESSING_ERROR` and whose message carries the original failure.

## What persists between turns

The GMI's conversation history (a window of 20 messages unless the persona sets `conversationContextConfig.maxMessages`), its reasoning trace (500 entries by default, configurable per persona), its mood and user context in working memory, and, when attached, the cognitive memory traces it encoded. Nothing persists across a restart unless the host configured a storage adapter and a durable memory brain.
