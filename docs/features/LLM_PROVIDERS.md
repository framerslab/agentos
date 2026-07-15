# LLM Providers — multi-provider configuration & routing

AgentOS abstracts every LLM behind a single [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface. Twelve providers are wired in directly — ten via API key, two via local CLI bridges that ride an existing Claude Max or Google account subscription. OpenRouter, included in the twelve, fans out to 200+ additional models from the same set of vendors. Every provider speaks the same streaming protocol, supports the same tool-call shape (with the documented exceptions below), and participates in the same cost ledger. The fallback chain is auto-built from whichever keys are set in the environment and is overridable per agent.

---

## Table of Contents

1. [Overview](#overview)
2. [Provider Matrix](#provider-matrix)
3. [Quick Start](#quick-start)
4. [Auto-Detection Order](#auto-detection-order)
5. [Provider Configuration](#provider-configuration)
6. [Fallback Behavior](#fallback-behavior)
7. [Cost Tiers](#cost-tiers)
8. [Provider Details](#provider-details)
   - [OpenAI](#openai)
   - [Anthropic](#anthropic)
   - [Google Gemini](#google-gemini)
   - [Groq](#groq)
   - [Together AI](#together-ai)
   - [Mistral AI](#mistral-ai)
   - [xAI (Grok)](#xai-grok)
   - [OpenRouter](#openrouter)
   - [Atlas Cloud](#atlas-cloud)
   - [Ollama](#ollama)
9. [Programmatic Configuration](#programmatic-configuration)
10. [Adding a Custom Provider](#adding-a-custom-provider)
11. [Provider Capabilities Detail](#provider-capabilities-detail)
12. [Related Documentation](#related-documentation)

---

## Overview

AgentOS abstracts LLM access behind a unified [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface. You configure providers via environment variables, and AgentOS handles model selection, streaming, tool calling, retries, and fallback routing.

**Key features:**

- **12 providers** supported out of the box (10 API-key + 2 CLI-based)
- **CLI providers**: Use your Claude Max or Google account subscription via local CLI — no API key needed
- **Auto-detection**: Set an API key or install a CLI and the provider is available
- **Fallback**: Automatic retry with alternate providers on failure (`fallbackProviders`)
- **Cost-aware caps**: Per-run cost ceilings via `controls.maxCostUSD`; route requests to cheaper models with a custom router
- **Streaming**: All providers support streaming with a unified async iterator
- **Tool calling**: Unified function/tool calling across providers that support it

---

## Provider Matrix

| Provider | Env Var | Default Model | Streaming | Tool Calling | Vision | Embedding | Cost Tier |
|----------|---------|---------------|-----------|--------------|--------|-----------|-----------|
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | Yes | Yes | Yes | Yes | $$$ |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5-20250929` | Yes | Yes | Yes | No | $$$ |
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | Yes | Yes | Yes | Yes | $$ |
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Yes | Yes | No | No | $ |
| **Together** | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Yes | Yes | No | Yes | $ |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-large-latest` | Yes | Yes | No | Yes | $$ |
| **xAI** | `XAI_API_KEY` | `grok-2` | Yes | Yes | Yes | No | $$ |
| **OpenRouter** | `OPENROUTER_API_KEY` | `openai/gpt-4o` | Yes | Yes | Yes* | Yes* | Varies |
| **Atlas Cloud** | `ATLASCLOUD_API_KEY` | `deepseek-ai/deepseek-v4-pro` | Yes | Yes | No | No | Varies |
| **Ollama** | `OLLAMA_BASE_URL` | `llama3.2` | Yes | Partial | Model-dep. | Yes | Free |
| **Claude Code CLI** | _(PATH detection)_ | `claude-sonnet-4-5-20250929` | Yes | Yes | Yes | No | Free* |
| **Gemini CLI** | _(PATH detection)_ | `gemini-2.5-flash` | Yes | Partial** | Yes | No | Free* |

*CLI providers use your existing subscription — $0 per token.
**Gemini CLI tool calling uses XML prompt-based parsing (less reliable than native API tool calling).

> **Gemini CLI ToS Warning**: Google's Gemini CLI ToS may prohibit third-party subprocess invocation with OAuth auth. Use `gemini` with API key for production. See [CLI Providers](./CLI_PROVIDERS.md) for details.

*OpenRouter capabilities depend on the underlying model selected.

---

## Quick Start

### Option 1: Environment Variable (Simplest)

Set one API key and start using AgentOS:

```bash
export OPENAI_API_KEY=sk-...
```

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({});  // Auto-detects from env (OpenAI here)
const result = await myAgent.generate('Hello, world!');
console.log(result.text);
```

### Option 2: Programmatic

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
});
```

The `agent()` factory is **synchronous** — it does not return a Promise. The first network call happens on `generate()` / `stream()` / `session().send()`.

---

## Auto-Detection Order

When neither `provider` nor `model` is set, AgentOS checks for API keys in this
order and uses the first one found:

1. `OPENROUTER_API_KEY` → OpenRouter
2. `OPENAI_API_KEY` → OpenAI
3. `ATLASCLOUD_API_KEY` → Atlas Cloud
4. `ANTHROPIC_API_KEY` → Anthropic
5. `GEMINI_API_KEY` → Google Gemini
6. `GROQ_API_KEY` → Groq
7. `TOGETHER_API_KEY` → Together AI
8. `MISTRAL_API_KEY` → Mistral
9. `XAI_API_KEY` → xAI
10. `which claude` → Claude Code CLI (PATH detection — no API key, uses Max subscription)
11. `which gemini` → Gemini CLI (PATH detection — no API key, uses Google account)
12. `OLLAMA_BASE_URL` → Ollama

You can override auto-detection in four ways, highest priority first:

1. **Inline** — `agent({ provider: '...', apiKey: '...' })` on a single call.
2. **Module-level default** — `setDefaultProvider({ provider, apiKey })` once at boot. Every subsequent call inherits it; inline opts still win when supplied. Useful when credentials live in a secrets manager rather than `.env`.
3. **Reorder the auto-detect chain** — `setProviderPriority(['anthropic', 'openai', ...])` to change which env-var keys are preferred when multiple are set, without forcing a single provider. Empty array disables auto-detect entirely.
4. **CLI flag** — for the [Wunderland](https://wunderland.sh) CLI, pass `--provider <name>`.

```typescript
import { setDefaultProvider, generateText, agent } from '@framers/agentos';

setDefaultProvider({
  provider: 'openai',
  apiKey: process.env.MY_OWN_KEY,
  // optional: model: 'gpt-4o-mini', baseUrl: '...'
});

// No env vars, no inline opts — just works:
const { text } = await generateText({ prompt: 'hello' });
const bot = agent({ instructions: '...' });

// Inline still wins:
generateText({ apiKey: 'sk-tenant-scoped', prompt: 'isolated call' });
```

---

## Provider Configuration

Each provider is configured via environment variables. You can set them in
your shell or `.env` file:

```bash
# .env

# Primary provider
OPENAI_API_KEY=sk-...

# Fallback provider
OPENROUTER_API_KEY=sk-or-...

# OpenAI-compatible provider
ATLASCLOUD_API_KEY=...

# Local provider (no API key needed)
OLLAMA_BASE_URL=http://localhost:11434
```

### Per-Agent Override

Individual agents pick their provider/model directly in the `agent({ ... })` config:

```typescript
import { agent } from '@framers/agentos';

const writer = agent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  apiKey: process.env.ANTHROPIC_API_KEY, // optional override
});
```

---

## Fallback Behavior

AgentOS supports automatic fallback when a provider request fails on a
retryable error (HTTP 402/429/5xx, network errors). Fallback is **on by
default** with an auto-built chain — to disable it, pass an empty array.

```
Primary Provider (e.g., Anthropic)
  ↓ fails (rate limit, timeout, error)
OpenRouter Fallback (if OPENROUTER_API_KEY is set)
  ↓ fails
Ollama Local Fallback (if OLLAMA_BASE_URL is set)
  ↓ fails
Error returned to caller
```

### Configuring Fallback

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  // Ordered fallback chain — each entry can override the model.
  fallbackProviders: [
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-5-20250929' },
    { provider: 'ollama',     model: 'llama3.2' },
  ],
  onFallback: (err, next) => {
    console.warn(`Falling back to ${next}: ${err.message}`);
  },
});

// Disable fallback entirely:
const strict = agent({ provider: 'anthropic', fallbackProviders: [] });
```

### OpenRouter as Universal Fallback

Setting `OPENROUTER_API_KEY` automatically enables it as a fallback for any
primary provider in the auto-built chain. OpenRouter routes to 200+ models
across all major providers.

```bash
# Primary: Anthropic. Fallback: OpenRouter (automatic)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
```

---

## Cost Tiers

AgentOS tracks token usage and cost across all providers:

| Tier | Providers | Approximate Cost (1M tokens) |
|------|-----------|------------------------------|
| **$** (Budget) | Groq, Together, Ollama (free) | $0.00–$0.60 |
| **$$** (Standard) | Gemini, Mistral, xAI, OpenRouter (varies), Atlas Cloud (varies) | $0.50–$3.00 |
| **$$$** (Premium) | OpenAI, Anthropic | $3.00–$15.00 |

### Cost-Aware Caps

Per-run hard cost caps live on `controls`:

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'anthropic',
  controls: {
    maxCostUSD: 0.05,           // Stop the run if total cost exceeds $0.05
    maxTotalTokens: 50_000,     // Stop on token cap
    maxDurationMs: 30_000,      // Wall-clock cap
    onLimitReached: 'stop',     // 'stop' | 'warn' | 'error'
  },
});
```

For cheap-first routing across multiple models, attach a custom [`IModelRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/IModelRouter.ts)
via `agent({ router })` — the router decides which provider/model to call per
request. See [Cost Optimization](./COST_OPTIMIZATION.md) for the full guide.

---

## Provider Details

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `gpt-4o` | 128K | Yes | Yes | Best all-around |
| `gpt-4o-mini` | 128K | Yes | Yes | Fast, cheap |
| `o1` | 200K | Yes | Yes | Reasoning model |
| `o3-mini` | 200K | No | Yes | Fast reasoning |
| `gpt-image-1` | — | — | — | Image generation only |

**OAuth support:** Use your ChatGPT subscription instead of an API key via the device code flow. See [OAuth Auth](./OAUTH_AUTH.md) for details.

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `claude-fable-5` | 1M | Yes | Yes | Most capable ($10/$50 per MTok) |
| `claude-opus-4-8` | 1M | Yes | Yes | Best for agents and coding |
| `claude-sonnet-4-6` | 1M | Yes | Yes | Best value |
| `claude-haiku-4-5-20251001` | 200K | Yes | Yes | Fastest |

Reasoning-default models (`claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`) reject `temperature` and `top_p` with HTTP 400; the provider drops both automatically for these models and sends adaptive thinking when a thinking budget is requested.

### Google Gemini

```bash
export GEMINI_API_KEY=AIza...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `gemini-2.5-pro` | 1M | Yes | Yes | Largest context |
| `gemini-2.5-flash` | 1M | Yes | Yes | Fast, large context |
| `gemini-2.0-flash` | 1M | Yes | Yes | Previous gen |

### Groq

```bash
export GROQ_API_KEY=gsk_...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `llama-3.3-70b-versatile` | 128K | No | Yes | Best Groq model |
| `llama-3.1-8b-instant` | 128K | No | Yes | Ultra-fast |
| `mixtral-8x7b-32768` | 32K | No | Yes | Mixtral on Groq |

Groq provides extremely fast inference (~500 tok/s) via custom LPU hardware.

### Together AI

```bash
export TOGETHER_API_KEY=...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | 128K | No | Yes | Default |
| `meta-llama/Llama-3.1-405B-Instruct-Turbo` | 128K | No | Yes | Largest open model |
| `mistralai/Mixtral-8x22B-Instruct-v0.1` | 64K | No | Yes | Mixtral |

### Mistral AI

```bash
export MISTRAL_API_KEY=...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `mistral-large-latest` | 128K | No | Yes | Best Mistral model |
| `codestral-latest` | 32K | No | Yes | Code-optimized |
| `mistral-small-latest` | 32K | No | Yes | Fast, cheap |

### xAI (Grok)

```bash
export XAI_API_KEY=xai-...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `grok-2` | 128K | Yes | Yes | Default |
| `grok-2-mini` | 128K | No | Yes | Faster |

### OpenRouter

```bash
export OPENROUTER_API_KEY=sk-or-...
```

OpenRouter is a multi-provider proxy that routes to 200+ models. Specify the
model using the `provider/model` format:

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4-5-20250929',
});
```

Popular OpenRouter models:
- `openai/gpt-4o`
- `anthropic/claude-sonnet-4-5-20250929`
- `google/gemini-2.5-flash`
- `meta-llama/llama-3.3-70b-instruct`

### Atlas Cloud

```bash
export ATLASCLOUD_API_KEY=...
# Optional endpoint override for proxies or private deployments:
export ATLASCLOUD_BASE_URL=https://api.atlascloud.ai/v1
```

Atlas Cloud uses an OpenAI-compatible `/v1/chat/completions` endpoint, so it
shares AgentOS's standard OpenAI-compatible transport, streaming, tool-call, and
structured-output handling.

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `deepseek-ai/deepseek-v4-pro` | 1M | No | Yes | Default long-context reasoning model |
| `qwen/qwen3.5-flash` | 1M | No | Partial | Fast chat model |

### Ollama

```bash
export OLLAMA_BASE_URL=http://localhost:11434
```

Run any open model locally. No API key, no cost, full privacy.

```bash
# Pull models manually
ollama pull llama3.2
ollama pull codellama
ollama pull dolphin-mixtral
```

| Model | Parameters | Context | Tool Calling | Notes |
|-------|-----------|---------|-------------|-------|
| `llama3.2` | 3B/8B | 128K | Partial | General-purpose |
| `codellama` | 7B/13B/34B | 16K | No | Code-optimized |
| `dolphin-mixtral` | 8x7B | 32K | No | Uncensored |
| `mistral` | 7B | 32K | Partial | Fast |
| `phi3` | 3.8B | 128K | No | Small, fast |

---

## Programmatic Configuration

### Provider + Model + Auth

The agent factory accepts `provider`, `model`, `apiKey`, and `baseUrl`
directly. There is no separate `LLMProviderConfig` type — these fields live
on [`AgentOptions`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) (and on [`BaseAgentConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts), so every sub-agent in an
`agency()` roster takes the same fields).

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
  apiKey: process.env.ANTHROPIC_API_KEY,        // optional override
  baseUrl: undefined,                           // optional custom base URL
});
```

### Per-Call Overrides

`generate()` and `stream()` accept the same provider/model fields as a
per-call override on top of the agent's base config — useful for sending one
specific question through a different provider:

```typescript
const result = await myAgent.generate(
  'Run this complex analysis as a one-off.',
  {
    provider: 'openai',
    model: 'gpt-4o',
  },
);
```

---

## Adding a Custom Provider

Implement the [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface from `@framers/agentos` to add a custom
LLM provider. Provider registration today is wired up via
[`AIModelProviderManager`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts) — there is no public `registerLLMProvider()`
shortcut yet; instead, instantiate your provider and inject it via the
manager surfaced on `AgentOSConfig.dependencies` when constructing the
runtime.

```typescript
import type { IProvider } from '@framers/agentos';

class MyProvider implements IProvider {
  readonly id = 'my-provider';
  readonly name = 'My Custom LLM';

  // ... implement generateCompletion / streamCompletion / listModels / etc.
  // See packages/agentos/src/core/llm/providers/IProvider.ts for the full
  // contract; the existing OpenAI / Anthropic / Ollama implementations are
  // good references.
}
```

Look at any class under [`src/core/llm/providers/implementations/`](https://github.com/framerslab/agentos/tree/master/src/core/llm/providers/implementations) for a
complete reference — the OpenAI and Anthropic providers are the most fully
exercised paths.

---

## Provider Capabilities Detail

### Tool Calling Support

| Provider | Parallel Tools | Structured Output | Tool Choice | Notes |
|----------|---------------|-------------------|-------------|-------|
| OpenAI | Yes | Yes (strict mode) | `auto/none/required/specific` | Gold standard |
| Anthropic | Yes | Yes | `auto/any/specific` | Strong tool use |
| Gemini | Yes | Yes | `auto/none/any` | Good support |
| Groq | Yes | Partial | `auto/none` | Fast but basic |
| Together | Yes | No | `auto/none` | Model-dependent |
| Mistral | Yes | No | `auto/none/any` | Good support |
| xAI | Yes | No | `auto/none` | Basic tool use |
| OpenRouter | Model-dependent | Model-dependent | Model-dependent | Pass-through |
| Atlas Cloud | Yes | Yes | `auto/none` | OpenAI-compatible JSON schema mode |
| Ollama | Partial | No | `auto/none` | Model-dependent |

### Embedding Support

| Provider | Models | Dimensions | Batch Size |
|----------|--------|-----------|------------|
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large` | 256–3072 | 2048 |
| Gemini | `text-embedding-004` | 768 | 2048 |
| Together | `togethercomputer/m2-bert-80M-*` | 768 | 512 |
| Mistral | `mistral-embed` | 1024 | 512 |
| Ollama | `nomic-embed-text`, `mxbai-embed-large` | 768–1024 | 512 |

---

## Related Documentation

- [Getting Started](./GETTING_STARTED.md) — Initial setup and configuration
- [Cost Optimization](./COST_OPTIMIZATION.md) — Budget management and routing
- [Architecture](./ARCHITECTURE.md) — System architecture overview
- [Structured Output](./STRUCTURED_OUTPUT.md) — JSON schema enforcement per provider
