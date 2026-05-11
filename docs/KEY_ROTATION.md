# API Key Rotation

AgentOS provides automatic round-robin API key rotation for every provider. Set any API key environment variable to a comma-separated list and rotation happens transparently.

## Usage

```bash
# Single key:
ELEVENLABS_API_KEY=sk_primary

# Multiple keys with automatic rotation:
ELEVENLABS_API_KEY=sk_primary,sk_backup,sk_overflow

# Works for any provider:
OPENAI_API_KEY=sk-key1,sk-key2
ANTHROPIC_API_KEY=sk-ant-key1,sk-ant-key2
```

## How It Works

**Weighted round-robin:** The first key is selected ~2x more often than subsequent keys. In a 3-key pool, selection frequency is roughly 50% / 25% / 25%.

**Quota detection:** When an API call returns a rate-limit or quota error, the key is automatically marked as exhausted and removed from rotation for 15 minutes. The next available key is tried immediately.

Detected error signals:
- HTTP 429 (rate limited)
- HTTP 402 (payment required)
- HTTP 456 (DeepL quota)
- `quota_exceeded` (ElevenLabs)
- `insufficient_quota` (OpenAI)
- `overloaded_error` (Anthropic)
- `RESOURCE_EXHAUSTED` (Google/Gemini)

**Shared pools:** Providers that share an environment variable share a single key pool. If ElevenLabs TTS exhausts a key, ElevenLabs STT and SFX also skip it.

| Env Var | Shared By |
|---|---|
| `OPENAI_API_KEY` | LLM, TTS, STT, Image, Realtime |
| `ELEVENLABS_API_KEY` | TTS (batch + streaming), STT, SFX |
| `FAL_API_KEY` | Image, Video, Audio |
| `REPLICATE_API_TOKEN` | Image, Video, Audio |
| `STABILITY_API_KEY` | Image, Audio |
| `OPENROUTER_API_KEY` | LLM, Image |

## Supported Providers

Every AgentOS provider that accepts an API key supports rotation:

- **LLM:** OpenAI, Anthropic, OpenRouter, Gemini, Groq, Mistral, Together, xAI
- **Speech TTS:** ElevenLabs, OpenAI TTS, Azure Speech
- **Speech STT:** OpenAI Whisper, Deepgram, AssemblyAI, ElevenLabs
- **Voice Pipeline:** ElevenLabs Streaming TTS/STT, OpenAI Realtime, Deepgram Streaming
- **Image:** OpenAI DALL-E, Stability, Flux, Fal, Replicate, OpenRouter
- **Video:** Fal, Replicate, Runway
- **Audio:** ElevenLabs SFX, Suno, Udio, Stable Audio, Fal, Replicate
- **Web Search:** Serper, Tavily, Brave, Firecrawl
- **NLP:** DeepL, OpenAI Translation

## Implementation

The key pool is implemented in [`src/core/providers/`](https://github.com/framersai/agentos/tree/master/src/core/providers):

- `ApiKeyPool.ts` — Weighted round-robin with exhaustion cooldown
- `ApiKeyPoolRegistry.ts` — Singleton pools keyed by env var name
- `quotaErrors.ts` — Cross-provider quota error detection
