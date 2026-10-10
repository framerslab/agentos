# API Key Rotation

AgentOS rotates API keys for the providers listed under [Supported Providers](#supported-providers). Set the provider's API key environment variable (or the `apiKey` you pass) to a comma-separated list and each provider instance rotates through it.

## Usage

```bash
# Single key:
ELEVENLABS_API_KEY=sk_primary

# Multiple keys with automatic rotation:
ELEVENLABS_API_KEY=sk_primary,sk_backup,sk_overflow

# LLM providers that rotate:
OPENAI_API_KEY=sk-key1,sk-key2
ANTHROPIC_API_KEY=sk-ant-key1,sk-ant-key2
```

## How It Works

**Weighted round-robin:** Each provider instance builds its own [`ApiKeyPool`](https://github.com/framerslab/agentos/blob/master/src/core/providers/ApiKeyPool.ts) from its key string. The first key fills two rotation slots and every other key one, so in a 3-key pool the selection frequency is 50% / 25% / 25%. A single key is used as given.

**Resting a key:** A key marked exhausted leaves rotation for 15 minutes; when every key is resting, the pool returns the one whose rest ends first. Which failures mark a key depends on the provider:

| Provider | Marks the key on | Then |
|---|---|---|
| Anthropic, Gemini (LLM) | HTTP 429 | The next attempt or request draws another key. |
| OpenRouter (LLM) | HTTP 402 or 429 | The next attempt or request draws another key. |
| ElevenLabs TTS and SFX, Deepgram TTS, and the voice pipeline's batch TTS for OpenAI, ElevenLabs, Cartesia, Hume and Deepgram Aura | An error `isQuotaError()` recognizes, when the pool holds more than one key | The request is retried once on the next key. |

Every other provider in the list below rotates its keys but never marks one exhausted.

`isQuotaError()` recognizes HTTP 429, 402 and 456, and response bodies that contain `quota_exceeded`, `rate_limit_exceeded`, `insufficient_quota`, `overloaded_error`, `resource_exhausted` or `rate_limit` (case-insensitive).

**Pools are per instance:** two providers that read the same environment variable keep separate pools, so a key one of them rests stays in the other's rotation. `getKeyPool()` in `ApiKeyPoolRegistry.ts` returns one shared pool per environment variable; no built-in provider calls it.

## Supported Providers

- **LLM:** OpenAI, Anthropic, Gemini, OpenRouter and Requesty; Groq, Mistral, Together and xAI, each of which sends its requests through an `OpenAIProvider` instance and draws its key from that instance's pool
- **Speech TTS:** ElevenLabs, OpenAI TTS, Deepgram, MiniMax
- **Speech STT:** OpenAI Whisper, Deepgram, AssemblyAI
- **Voice Pipeline:** OpenAI batch TTS and Realtime, ElevenLabs batch and streaming TTS and streaming STT, Cartesia batch and streaming TTS, Hume batch and streaming TTS, Deepgram Aura batch and streaming TTS and Deepgram streaming STT
- **Image:** OpenAI, Stability, Flux, Fal, Replicate, OpenRouter
- **Video:** Fal, Replicate, Runway
- **Audio:** ElevenLabs SFX, Suno, Udio, Stable Audio, Fal, Replicate
- **Segmentation:** Replicate
- **Web Search:** Serper, Tavily, Brave, Firecrawl

Azure Speech (TTS and STT), DeepL and OpenAI translation send the configured key as given, so give them a single key. Give LiteLLM a single key too: its completions, streams and embeddings draw a key from an `OpenAIProvider` pool, and its model listing sends the configured string as given.

## Implementation

The key pool is implemented in [`src/core/providers/`](https://github.com/framerslab/agentos/tree/master/src/core/providers):

- `ApiKeyPool.ts`: weighted round-robin with exhaustion cooldown
- `ApiKeyPoolRegistry.ts`: one shared pool per environment variable (`getKeyPool()`), not used by the built-in providers
- `quotaErrors.ts`: cross-provider quota error detection (`isQuotaError()`)
