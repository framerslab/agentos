# API Reference

Everything is one import. Pick the function that fits your task:

```typescript
import {
  generateText, streamText,        // Text generation
  generateObject, streamObject,    // Structured output (Zod validated)
  generateImage, transferStyle,    // Image generation & style transfer
  generateVideo, analyzeVideo,     // Video generation & analysis
  generateMusic, generateSFX,      // Audio generation
  performOCR,                      // Vision / OCR
  embedText,                       // Embeddings
  agent,                           // Multi-turn agent sessions
  agency,                          // Multi-agent teams
} from '@framers/agentos';
```

## Quick Reference

| Function | What it does | Example |
|----------|-------------|---------|
| `generateText()` | One-shot text generation | `await generateText({ provider: 'openai', prompt: '...' })` |
| `streamText()` | Stream text in real-time | `for await (const d of streamText({...}).textStream) {}` |
| `generateObject()` | Extract structured JSON (Zod) | `await generateObject({ schema: z.object({...}), prompt: '...' })` |
| `generateImage()` | Generate images (with character consistency) | `await generateImage({ provider: 'openai', prompt: '...' })` |
| `transferStyle()` | Style transfer between images | `await transferStyle({ image: src, styleReference: ref, prompt: '...' })` |
| `generateVideo()` | Generate video from text/image | `await generateVideo({ prompt: '...' })` |
| `generateMusic()` | Generate music | `await generateMusic({ prompt: '...' })` |
| `performOCR()` | Extract text from images | `await performOCR({ imagePath: './doc.png' })` |
| `embedText()` | Generate embeddings | `await embedText({ input: ['hello'] })` |
| `agent()` | Multi-turn sessions with memory | `const a = agent({ provider: 'openai' })` |
| `souledAgent()` | Soul-file agent whose long-term memory is its `memory/` wiki | `await souledAgent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' })` |
| `agency()` | Multi-agent teams | `const team = agency({ agents: {...}, strategy: 'parallel' })` |

All functions accept `provider` as a top-level key.

## Provider Resolution

### Calling Styles

Two styles for specifying provider and model:

```ts
// 1. Provider-first — AgentOS picks the best default model for the task
await generateText({ provider: 'openai', prompt: '...' });

// 2. Provider + explicit model — full control
await generateText({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', prompt: '...' });
```

### Provider Defaults

When you supply `provider` without an explicit `model`, AgentOS resolves the default model
for the requested task automatically:

| Provider                 | Type  | Text default               | Image default                    | Embedding default        | Env var                           |
| ------------------------ | ----- | -------------------------- | -------------------------------- | ------------------------ | --------------------------------- |
| `openai`                 | Cloud | `gpt-4o`                   | `gpt-image-1`                    | `text-embedding-3-small` | `OPENAI_API_KEY`                  |
| `anthropic`              | Cloud | `claude-sonnet-4-5-20250929` | —                                | —                        | `ANTHROPIC_API_KEY`               |
| `gemini`                 | Cloud | `gemini-2.5-flash`         | —                                | —                        | `GEMINI_API_KEY`                  |
| `openrouter`             | Cloud | `openai/gpt-4o`            | —                                | —                        | `OPENROUTER_API_KEY`              |
| `claude-code-cli`        | Local | `claude-sonnet-4-5-20250929` | —                                | —                        | `which claude`                    |
| `gemini-cli`             | Local | `gemini-2.5-flash`         | —                                | —                        | `which gemini`                    |
| `stability`              | Cloud | —                          | `stable-diffusion-xl-1024-v1-0`  | —                        | `STABILITY_API_KEY`               |
| `replicate`              | Cloud | —                          | `black-forest-labs/flux-1.1-pro` | —                        | `REPLICATE_API_TOKEN`             |
| `ollama`                 | Local | `llama3.2`                 | `stable-diffusion`               | `nomic-embed-text`       | `OLLAMA_BASE_URL`                 |
| `stable-diffusion-local` | Local | —                          | `v1-5-pruned-emaonly`            | —                        | `STABLE_DIFFUSION_LOCAL_BASE_URL` |

When neither `provider` nor `model` is given, AgentOS checks configured runtimes in order
(`OPENROUTER_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `GEMINI_API_KEY` → `GROQ_API_KEY` → `TOGETHER_API_KEY` → `MISTRAL_API_KEY` → `XAI_API_KEY` → `which claude` → `which gemini` → `OLLAMA_BASE_URL`). Or call `setDefaultProvider({ provider, apiKey })` once at boot to skip env vars entirely; every subsequent function inherits that default while still letting inline `apiKey` win when supplied.

### Inline API Keys

Every function accepts `apiKey` and `baseUrl` as top-level parameters, overriding the corresponding environment variable for that call:

```ts
// Pass apiKey directly — useful for multi-tenant apps, tests, or dynamic config
await generateText({
  provider: 'openai',
  apiKey: 'sk-my-specific-key',     // overrides OPENAI_API_KEY
  prompt: 'Hello world',
});

// Works on agent() and agency() too
const bot = agent({
  provider: 'anthropic',
  apiKey: process.env.CUSTOMER_KEY,  // per-customer key
  instructions: 'You are a helpful assistant.',
});
```

### Local Providers

Local providers don't require API keys — just a `baseUrl` (or the corresponding env var):

```ts
// Ollama — runs any GGUF model locally
await generateText({
  provider: 'ollama',
  model: 'llama3.2',
  prompt: 'Explain quantum entanglement simply.',
  baseUrl: 'http://localhost:11434', // or set OLLAMA_BASE_URL
});

// Anthropic fallback: if ANTHROPIC_API_KEY is unset but OPENROUTER_API_KEY is set,
// AgentOS automatically routes anthropic requests through OpenRouter.
```

## `generateText()`

```ts
import { generateText } from '@framers/agentos';

// Provider-first: AgentOS picks the default model for the provider.
const { text, usage } = await generateText({
  provider: 'openai',
  prompt: 'Summarize the TCP three-way handshake in 3 bullets.',
});

console.log(text);
console.log(usage.totalTokens);
```

`generateText({ tools })` and `streamText({ tools })` now accept three useful
forms:

- A named high-level tool map
- An [`ExternalToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/externalToolRegistry.ts) (`Record`, `Map`, or iterable)
- A prompt-only `ToolDefinitionForLLM[]`

External registries are exposed to the model and executed when called.
Prompt-only `ToolDefinitionForLLM[]` are exposed to the model too, but if the
model calls one without an executor attached, AgentOS returns an explicit tool
error instead of silently no-oping.

The same `tools` forms now work on `agent({ tools })` and `agency({ tools })`.
When an agency-level tool set is combined with per-agent tools, AgentOS
normalizes both sides first and then merges by tool name, with the per-agent
tool winning on collisions.

Persist helper usage for later inspection:

```ts
import { generateText, getRecordedAgentOSUsage } from '@framers/agentos';

await generateText({
  provider: 'openai',
  prompt: 'Summarize QUIC in one sentence.',
  usageLedger: {
    enabled: true,
    sessionId: 'demo-session',
  },
});

const totals = await getRecordedAgentOSUsage({ enabled: true, sessionId: 'demo-session' });
console.log(totals.totalTokens);
```

## `streamText()`

```ts
import { streamText } from '@framers/agentos';

const result = streamText({
  provider: 'openai',
  prompt: 'Stream a short explanation of how TLS differs from TCP.',
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}

console.log(await result.text);
```

## `agency().stream()`

`streamText()` is a single-call raw stream. `agency().stream()` separates raw
live chunks from the finalized post-guardrail/post-HITL answer:

```ts
import { agency, type AgencyStreamResult } from '@framers/agentos';

const team = agency({
  provider: 'openai',
  strategy: 'sequential',
  agents: {
    researcher: { instructions: 'Collect the key facts.' },
    writer: { instructions: 'Turn the facts into a concise answer.' },
  },
  hitl: {
    approvals: { beforeReturn: true },
    handler: async () => ({
      approved: true,
      modifications: { output: 'Approved for delivery.' },
    }),
  },
});

const stream: AgencyStreamResult = team.stream('Summarize HTTP/3 rollout risks.');

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk); // raw live output
}
process.stdout.write('\n');

for await (const approved of stream.finalTextStream) {
  console.log('Approved answer:', approved);
}

console.log('Agent calls:', await stream.agentCalls);
console.log('Final text:', await stream.text);
```

Use:

- `textStream` for low-latency token UX
- `finalTextStream` or `text` for the finalized approved answer
- `fullStream` when you also need structured events like `final-output`

See [Agency API](./AGENCY_API.md) and [Streaming Semantics](./STREAMING_SEMANTICS.md)
for the full contract.

## [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts)

Use [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts) when you want grounded answers over a local markdown corpus
without booting the full AgentOS runtime.

```ts
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  availableTools: ['web_search'],
});

await router.init();

console.log(router.getCorpusStats());

const result = await router.route('How does memory retrieval work?');
console.log(result.answer);
console.log(result.tiersUsed);
console.log(result.fallbacksUsed);

await router.close();
```

`router.getCorpusStats()` returns a [`QueryRouterCorpusStats`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/types.ts) snapshot that tells
you what is actually live in the current host:

- corpus size: `configuredPathCount`, `chunkCount`, `topicCount`, `sourceCount`
- bundled platform knowledge: `platformKnowledge.total` plus per-category counts
- retrieval path: `vector+keyword-fallback` or `keyword-only`
- embedding health: `embeddingStatus`
- runtime truth: `graphRuntimeMode`, `rerankRuntimeMode`, `deepResearchRuntimeMode`

Built-in status meanings:

- `embeddingStatus: 'active'` means vector embeddings initialized successfully
- `embeddingStatus: 'disabled-no-key'` means init stayed keyword-only because no embedding credential was available
- `embeddingStatus: 'failed-init'` means vector init was attempted but fell back to keyword-only mode after an error
- `graphRuntimeMode: 'heuristic'` means same-document / heading-overlap expansion
- `rerankRuntimeMode: 'heuristic'` means the built-in lexical reranker
- `deepResearchRuntimeMode: 'heuristic'` means the built-in local-corpus research synthesis path

Hosts can inject real `graphExpand`, `rerank`, and `deepResearch` hooks in the
constructor; those modes then become `active`.

See [Query Router](./QUERY_ROUTER.md) for the full contract and host-hook examples.

## `generateImage()`

```ts
import { generateImage } from '@framers/agentos';

// Provider-first: resolves to gpt-image-1 by default for openai.
const result = await generateImage({
  provider: 'openai',
  prompt: 'A cinematic neon city skyline reflected in rain at night.',
  outputFormat: 'png',
});

console.log(result.provider);
console.log(result.images[0]?.mimeType);
```

## `generateVideo()`

```ts
import { generateVideo } from '@framers/agentos';

const result = await generateVideo({
  prompt: 'A drone flying over a misty forest at sunrise.',
  timeoutMs: 180_000,
  onProgress: (event) => console.log(event.status, event.progress, event.message),
  providerPreferences: {
    preferred: ['runway', 'replicate'],
    blocked: ['fal'],
  },
});

console.log(result.provider);
console.log(result.videos[0]?.url);
```

## `analyzeVideo()`

`analyzeVideo()` auto-creates a [`VisionPipeline`](https://github.com/framerslab/agentos/blob/master/src/io/vision/VisionPipeline.ts), uses the structured
[`VideoAnalyzer`](https://github.com/framerslab/agentos/blob/master/src/io/media/video/VideoAnalyzer.ts) pipeline under the hood, and auto-wires STT when a supported
speech provider credential is available (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`,
`ASSEMBLYAI_API_KEY`, or Azure Speech env vars).

```ts
import { analyzeVideo } from '@framers/agentos';

const result = await analyzeVideo({
  videoUrl: 'https://example.com/demo.mp4',
  prompt: 'What is the product demo showing?',
  transcribeAudio: true,
  maxFrames: 12,
});

console.log(result.description);
console.log(result.fullTranscript);
console.log(result.scenes?.length);
```

Host requirement: `ffmpeg` and `ffprobe` must be installed and available on `PATH`.

## `generateMusic()` and `generateSFX()`

```ts
import { generateMusic, generateSFX } from '@framers/agentos';

const music = await generateMusic({
  prompt: 'Warm analog synthwave with a slow build.',
  timeoutMs: 180_000,
  onProgress: (event) => console.log('music', event.status, event.message),
  providerPreferences: {
    preferred: ['suno', 'udio'],
  },
});

const sfx = await generateSFX({
  prompt: 'Heavy vault door closing with metallic reverb.',
  timeoutMs: 60_000,
  onProgress: (event) => console.log('sfx', event.status, event.message),
  providerPreferences: {
    preferred: ['elevenlabs-sfx', 'stable-audio'],
  },
});

console.log(music.audio[0]?.url);
console.log(sfx.audio[0]?.url);
```

## Media Provider Preferences

Image, video, music, and SFX helpers accept `providerPreferences` so callers can
reorder, block, or weight providers without hard-coding a single backend:

```ts
import type { MediaProviderPreference } from '@framers/agentos';

const preferredCloudOnly: MediaProviderPreference = {
  preferred: ['runway', 'replicate'],
  blocked: ['musicgen-local', 'audiogen-local'],
  weights: { runway: 3, replicate: 1 },
};
```

When `weights` are present, AgentOS chooses the primary provider from the
resolved list using weighted selection and keeps the remaining providers in
order as fallbacks.

### Built-in Image Providers

| Provider                 | Type      | Default model                    | API key env var       |
| ------------------------ | --------- | -------------------------------- | --------------------- |
| `openai`                 | Cloud API | `gpt-image-1`                    | `OPENAI_API_KEY`      |
| `stability`              | Cloud API | `stable-diffusion-xl-1024-v1-0`  | `STABILITY_API_KEY`   |
| `replicate`              | Cloud API | `black-forest-labs/flux-1.1-pro` | `REPLICATE_API_TOKEN` |
| `openrouter`             | Cloud API | —                                | `OPENROUTER_API_KEY`  |
| `ollama`                 | Local     | `stable-diffusion`               | None (uses `baseUrl`) |
| `stable-diffusion-local` | Local     | `v1-5-pruned-emaonly`            | None (uses `baseUrl`) |

### Provider-Specific Options

Use the common options for the simple path, then drop down to namespaced
`providerOptions` when you need provider-native controls:

```ts
import { generateImage } from '@framers/agentos';

const poster = await generateImage({
  provider: 'stability',
  model: 'stable-image-core',
  prompt: 'An art deco travel poster for a moon colony',
  negativePrompt: 'text, watermark',
  providerOptions: {
    stability: {
      stylePreset: 'illustration',
      seed: 42,
      cfgScale: 8,
    },
  },
});

console.log(poster.images[0]?.mimeType);
```

Replicate and OpenRouter work the same way:

```ts
const replicateResult = await generateImage({
  provider: 'replicate',
  model: 'black-forest-labs/flux-schnell',
  prompt: 'A product photo of a titanium watch on black stone',
  aspectRatio: '16:9',
  providerOptions: {
    replicate: {
      outputQuality: 90,
      input: {
        go_fast: true,
      },
    },
  },
});
```

### Local Image Generation

Run Stable Diffusion locally without any API key:

```ts
// Via Ollama (if your Ollama install has a stable-diffusion model)
const local = await generateImage({
  provider: 'ollama',
  model: 'stable-diffusion',
  prompt: 'A watercolor landscape of rolling hills',
  baseUrl: 'http://localhost:11434', // or set OLLAMA_BASE_URL
});

// Via local Stable Diffusion WebUI (Automatic1111 / ComfyUI)
const sdLocal = await generateImage({
  provider: 'stable-diffusion-local',
  model: 'v1-5-pruned-emaonly',
  prompt: 'A brutalist house in fog',
  baseUrl: 'http://localhost:7860', // or set STABLE_DIFFUSION_LOCAL_BASE_URL
});
```

### Custom Image Provider

Register a provider factory for backends not covered by the built-ins:

```ts
import { generateImage, registerImageProviderFactory, type IImageProvider } from '@framers/agentos';

class ComfyUIProvider implements IImageProvider {
  providerId = 'comfyui';
  isInitialized = false;
  defaultModelId = 'sdxl';

  async initialize() {
    this.isInitialized = true;
  }

  async generateImage(request) {
    return {
      created: Math.floor(Date.now() / 1000),
      modelId: request.modelId,
      providerId: this.providerId,
      images: [{ url: 'https://example.invalid/image.png' }],
      usage: { totalImages: 1 },
    };
  }
}

registerImageProviderFactory('comfyui', () => new ComfyUIProvider());

await generateImage({
  provider: 'comfyui',
  model: 'sdxl',
  prompt: 'A brutalist house in fog',
});
```

## `agent()`

```ts
import { agent } from '@framers/agentos';

const researcher = agent({
  provider: 'openai',
  instructions: 'You are a concise research assistant.',
  memory: {
    types: ['episodic', 'semantic'],
    working: { enabled: true },
  },
  maxSteps: 4,
});

const session = researcher.session('demo');

const first = await session.send('What is QUIC?');
console.log(first.text);

const second = await session.send('Compare it to TCP.');
console.log(second.text);

console.log(await session.usage());
```

`agent({ tools })` accepts the same three forms as `generateText({ tools })`
and `streamText({ tools })`: named tool maps, [`ExternalToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/externalToolRegistry.ts)
(`Record`, `Map`, or iterable), and prompt-only `ToolDefinitionForLLM[]`.

### Per-agent identity via SOUL.md

Pass a `soul:` option to load identity, voice, hard limits, and HEXACO scores from a markdown workspace. The runtime injects `SOUL.md` body as the FIRST system message (before `instructions`, `chainOfThought`, or skills) and parses YAML frontmatter into structured persona config.

```ts
// Workspace path — loads SOUL.md + companion files (STYLE.md, IDENTITY.md, AGENTS.md, memory/)
agent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });

// Direct file path — loads only SOUL.md
agent({ provider: 'openai', soul: './personas/aria.soul.md' });

// Inline content — for tests and ephemeral agents
agent({ provider: 'openai', soul: { content: SOUL_MARKDOWN_STRING } });
```

The HEXACO frontmatter (`hexaco: { honestyHumility, emotionality, ... }`) flows into the same `PersonaDriftMechanism` and [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts) as inline `personality:` config. See [SOUL_FILES.md](../SOUL_FILES.md) for the full 6-file workspace spec.

### `souledAgent()`: soul plus a `memory/` wiki

`agent({ soul })` loads identity but leaves long-term memory to you. `souledAgent()` is the async factory that wires the whole loop in one call: it loads the soul, opens one `Memory` store under the workspace's `memory/.store/`, and attaches the soul's `memory/` markdown wiki as the agent's long-term memory.

```ts
import { souledAgent } from '@framers/agentos';

const aria = await souledAgent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  soul: '~/.agentos/agents/aria',
});
```

What it wires:

- **Read:** the `memory/index.md` catalog is injected into the system prelude, and the agent opens any page on demand with the `read_memory_page` tool.
- **Capture:** conversation the agent observes is written to the same store as episodic traces.
- **Fold:** those traces are merged into entity/concept pages when memory consolidates. `souledAgent` runs this on the agent's `close()`; call `await aria.memory.compileWiki()` to fold mid-session. Merges integrate new facts without clobbering human edits.

One `Memory` facade backs both the live memory and the wiki, so the markdown stays the source of truth and the vector/graph index is rebuilt from it. `souledAgent()` accepts every `agent()` option and returns the same `Agent`, plus `agent.memory` (the store) when the soul resolves to a workspace directory. An inline soul (`{ content }`) has no workspace, so it falls back to a plain `agent()`. Closing the agent also closes the store.

Runnable examples in the package source:

- [`packages/agentos/examples/high-level-api.mjs`](https://github.com/framerslab/agentos/blob/master/examples/high-level-api.mjs)
- [`packages/agentos/examples/generate-image.mjs`](https://github.com/framerslab/agentos/blob/master/examples/generate-image.mjs)
- [`packages/agentos/examples/agentos-config-tools.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agentos-config-tools.mjs)

## Full runtime: [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts)

```ts
import { AgentOS, AgentOSResponseChunkType } from '@framers/agentos';
import { createTestAgentOSConfig } from '@framers/agentos';

const agent = new AgentOS();
await agent.initialize(
  await createTestAgentOSConfig({
    tools: {
      open_profile: {
        description: 'Load a saved profile record by ID.',
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string' } },
          required: ['profileId'],
        },
        execute: async ({ profileId }) => ({
          success: true,
          output: { profile: { id: profileId, preferredTheme: 'solarized' } },
        }),
      },
    },
  })
);

for await (const chunk of agent.processRequest({
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'Explain how TCP handshakes work',
})) {
  if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
    process.stdout.write(chunk.textDelta);
  }
}
```

`AgentOSConfig.tools` now accepts the same three forms as the high-level
helpers: named tool maps, [`ExternalToolRegistry`](https://github.com/framersai/agentos/blob/master/src/api/runtime/externalToolRegistry.ts) (`Record`, `Map`, or
iterable), and prompt-only `ToolDefinitionForLLM[]`. AgentOS normalizes those
inputs during `initialize(...)` and registers them into the shared
[`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts), so direct `processRequest()` turns can plan against and
execute them without helper wrappers. If a config-registered tool collides with
an extension or pack tool name, the config tool wins at registration time.

If those external tool calls are AgentOS-registered tools, prefer
`processRequestWithRegisteredTools(...)`. It executes the registered tools with
the correct live-turn [`ToolExecutionContext`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) and resumes the stream for you:

```ts
import {
  AgentOS,
  AgentOSResponseChunkType,
  processRequestWithRegisteredTools,
} from '@framers/agentos';

const agent = await AgentOS.create();

for await (const chunk of processRequestWithRegisteredTools(agent, {
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'Search memory for my preferences',
})) {
  if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
    process.stdout.write(chunk.textDelta);
  }
}
```

If a live turn can mix AgentOS-registered tools with a stable host-managed tool
map, either configure `externalTools` once on `AgentOS.initialize(...)` or pass
`externalTools` to `processRequestWithRegisteredTools(...)`. It can be a
record, `Map`, or iterable of tool-like executors, and only missing tool names
will run through that host registry. Per-call `externalTools` override the
configured registry by tool name. Use `externalTools` for helper-level fallback
execution; use `AgentOSConfig.tools` when the tool should be permanently
registered and prompt-visible on direct runtime turns too.
If an `externalTools` entry also provides `description` and `inputSchema`, the
helper temporarily registers a proxy tool so the model can see and plan against
it during the turn. Execution-only entries without prompt metadata still work
for fallback execution, but they are not visible to the model up front.

If you need fully dynamic routing instead of a fixed tool map, keep using
`fallbackExternalToolHandler`.

For custom host-managed tools, keep using `processRequestWithExternalTools(...)`
and provide your own execution callback.

If you are building a lower-level/custom GMI path and only need prompt-visible
host tool schemas, configure `AgentOSConfig.externalTools` and call
`agent.listExternalToolsForLLM()`. That returns only the prompt-aware host
tools. You can turn those into raw OpenAI-style function schemas with
`formatToolDefinitionsForOpenAI(...)` or directly from the registry with
`formatExternalToolsForOpenAI(...)`.

`processRequestWithExternalTools(...)` is the simplest path while the same
AgentOS runtime stays alive. For restart-safe external tool execution, AgentOS
also persists actionable external pauses into the conversation metadata. A fresh
runtime can recover the pending request with
`getPendingExternalToolRequest(conversationId, userId)` and continue on a new
stream with `resumeExternalToolRequest(...)`:

If the pending tool calls are AgentOS-registered tools, prefer
`resumeExternalToolRequestWithRegisteredTools(...)`. It executes the registered
tools with the correct resume-time [`ToolExecutionContext`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) and then resumes the
stream for you.

```ts
import {
  AgentOS,
  AgentOSResponseChunkType,
  resumeExternalToolRequestWithRegisteredTools,
} from '@framers/agentos';

const agent = await AgentOS.create();
const pending = await agent.getPendingExternalToolRequest('conv-1', 'user-1');

if (pending) {
  for await (const chunk of resumeExternalToolRequestWithRegisteredTools(agent, pending, {
    organizationId: 'org-123',
  })) {
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
      process.stdout.write(chunk.textDelta);
    }
  }
}
```

If a persisted pause can mix AgentOS-registered tools with a stable
host-managed tool map, either configure `externalTools` once on
`AgentOS.initialize(...)` or pass `externalTools` to
`resumeExternalToolRequestWithRegisteredTools(...)`. The helper will execute
the registered tool calls itself and only delegate missing tool names to that
host registry before resuming the stream. Per-call `externalTools` override the
configured registry by tool name.
Prompt-aware entries with `description` and `inputSchema` are also registered
temporarily during the resumed stream so follow-up model calls can plan against
the same host tools.

If you need fully dynamic routing instead of a fixed tool map, keep using
`fallbackExternalToolHandler`.

For custom host-managed tools that are not registered in AgentOS, keep using
`resumeExternalToolRequest(...)` directly and supply your own tool results.

This recovery path assumes the conversation store is still available after the
original process exits.

## Guidance

- Show high-level examples first in README and landing guides.
- Keep low-level [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) examples in architecture, advanced usage, extensions, workflows, and runtime-control docs.
- Document both layers explicitly. They are complementary, not competing.
- Keep `generateImage()` provider-agnostic at the API boundary, but expose provider-specific knobs through `providerOptions` when needed.
- Do not force downstream libraries to adopt `agent()` unless the helper reaches feature parity with their runtime needs.
