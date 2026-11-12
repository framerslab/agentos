/**
 * Every covered console owner uses its own closed source constant.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** All paths are relative to the upstream repository, all values are library-authored words. */
const origins = {
  'src/api/generateText.ts': 'generate_text',
  'src/api/streamText.ts': 'stream_text',
  'src/api/model.ts': 'model',
  'src/api/observers.ts': 'observers',
  'src/api/runtime/approval-gate.ts': 'approval_gate',
  'src/api/runtime/spendBudget.ts': 'spend_budget',
  'src/api/runtime/tool-emulation/loop.ts': 'tool_loop',
  'src/cognition/rag/EmbeddingManager.ts': 'embedding_manager',
  'src/core/safety/LLMProviderHealthRegistry.ts': 'provider_health',
  'src/core/llm/providers/AIModelProviderManager.ts': 'provider_manager',
  'src/core/llm/routing/ModelRouter.ts': 'model_router',
  'src/core/llm/providers/implementations/AnthropicProvider.ts': 'anthropic_provider',
  'src/core/llm/providers/implementations/GeminiProvider.ts': 'gemini_provider',
  'src/core/llm/providers/implementations/GroqProvider.ts': 'groq_provider',
  'src/core/llm/providers/implementations/LiteLLMProvider.ts': 'litellm_provider',
  'src/core/llm/providers/implementations/MistralProvider.ts': 'mistral_provider',
  'src/core/llm/providers/implementations/OllamaProvider.ts': 'ollama_provider',
  'src/core/llm/providers/implementations/RequestyProvider.ts': 'requesty_provider',
  'src/core/llm/providers/implementations/TogetherProvider.ts': 'together_provider',
  'src/core/llm/providers/implementations/XAIProvider.ts': 'xai_provider',
  'src/core/llm/providers/implementations/cacheLeakDetector.ts': 'cache_leak_detector',
  'src/io/voice-pipeline/ListenSession.ts': 'listen_session',
  'src/io/voice-pipeline/ReconnectingSTT.ts': 'reconnecting_stt',
  'src/io/voice-pipeline/providers/StreamingSTTChain.ts': 'streaming_stt_chain',
  'src/io/voice-pipeline/LiveKitStreamTransport.ts': 'livekit_transport',
  'src/api/runtime/agencyLaunch/gmiLaunchTool.ts': 'gmi_launch_tool',
} as const;

/** Modules that write events through a handle: its component, then the fixed origin it reports while the mode is on. */
const handles = {
  'src/api/generateText.ts': ['fallback', 'generate_text'],
  'src/api/streamText.ts': ['fallback', 'stream_text'],
  'src/core/llm/providers/AIModelProviderManager.ts': ['llm.manager', 'provider_manager'],
  'src/core/llm/providers/implementations/OpenAIProvider.ts': ['llm', 'openai_provider'],
  'src/core/llm/providers/implementations/OpenRouterProvider.ts': ['llm', 'openrouter_provider'],
  'src/api/server/AgentOSServer.ts': ['http', 'agentos_server'],
  'src/cognition/nlp/language/log.ts': ['language', 'language_service'],
  'src/cognition/memory/retrieval/recall/log.ts': ['memory.recall', 'cognitive_memory'],
  'src/safety/guardrails/log.ts': ['guardrails', 'guardrails'],
} as const;

it('binds a fixed component at every covered source module', async () => {
  const module = await import('../../src/core/logging/contentSafeTelemetry.js');
  const components: unknown = Reflect.get(module, 'CONTENT_SAFE_COMPONENTS');
  expect(Array.isArray(components), 'published component tuple exists').toBe(true);
  if (Array.isArray(components) === false) throw new Error('missing component tuple');
  expect(Object.isFrozen(components)).toBe(true);
  for (const [path, component] of Object.entries(origins)) {
    const source = readFileSync(path, 'utf8');
    expect(source.includes(`const console = createContentSafeConsole('${component}');`), path).toBe(true);
    expect(components).toContain(component);
  }
  const owners = new Set<string>([...Object.values(origins), ...Object.values(handles).map(([, origin]) => origin)]);
  expect(components).toHaveLength(owners.size + 4);
  expect(new Set(components).size).toBe(components.length);
});

it('binds a fixed origin at every module that writes through an event handle', async () => {
  const { CONTENT_SAFE_COMPONENTS } = await import('../../src/core/logging/contentSafeTelemetry.js');
  for (const [path, [component, origin]] of Object.entries(handles)) {
    const source = readFileSync(path, 'utf8');
    expect(source.includes(`moduleLogger('${component}', '${origin}')`), path).toBe(true);
    expect(source.includes('lazyLogger('), `${path} writes through a handle with no origin`).toBe(false);
    expect(CONTENT_SAFE_COMPONENTS).toContain(origin);
  }
});
