# LLM Providers — multi-provider configuration & routing

AgentOS abstracts every LLM behind a single [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface. Thirteen providers are wired in directly: eleven reached with an API key or a base URL, and two local CLI bridges that ride an existing Claude Max or Google account subscription. Three of the thirteen are gateways: OpenRouter and Requesty route to models from many vendors, and LiteLLM is a proxy you host. Every provider speaks the same streaming protocol, supports the same tool-call shape (with the documented exceptions below), and participates in the same cost ledger. The fallback chain is auto-built from whichever keys are set in the environment and is overridable per agent.

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
   - [Requesty](#requesty)
   - [LiteLLM](#litellm)
   - [Ollama](#ollama)
9. [Programmatic Configuration](#programmatic-configuration)
10. [Adding a Custom Provider](#adding-a-custom-provider)
11. [Provider Capabilities Detail](#provider-capabilities-detail)
12. [Related Documentation](#related-documentation)

---

## Overview

AgentOS abstracts LLM access behind a unified [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface. You configure providers via environment variables, and AgentOS handles model selection, streaming, tool calling, retries, and fallback routing.

**Key features:**

- **13 providers** supported out of the box (11 by API key or base URL, 2 CLI-based)
- **CLI providers**: Use your Claude Max or Google account subscription via local CLI — no API key needed
- **Auto-detection**: Set an API key or install a CLI and the provider is available
- **Fallback**: Automatic retry with alternate providers on failure (`fallbackProviders`)
- **Cost-aware caps**: `agency()` checks `controls.maxCostUSD` and the other run limits after each run; `agent()` applies `controls.maxTotalTokens` and `controls.maxDurationMs` to each model call; a custom router sends requests to cheaper models
- **Streaming**: All providers support streaming with a unified async iterator
- **Tool calling**: Unified function/tool calling across providers that support it

---

## Provider Matrix

| Provider | Env Var | Default Model | Streaming | Tool Calling | Vision | Embedding | Cost Tier |
|----------|---------|---------------|-----------|--------------|--------|-----------|-----------|
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | Yes | Yes | Yes | Yes | $$$ |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Yes | Yes | Yes | No | $$$ |
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | Yes | Yes | Yes | Yes | $$ |
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Yes | Yes | No | No | $ |
| **Together** | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Yes | Yes | No | No | $ |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-large-latest` | Yes | Yes | No | Yes | $$ |
| **xAI** | `XAI_API_KEY` | `grok-2` | Yes | Yes | Yes | No | $$ |
| **OpenRouter** | `OPENROUTER_API_KEY` | `openai/gpt-4o` | Yes | Yes | Yes* | Yes* | Varies |
| **Requesty** | `REQUESTY_API_KEY` | `openai/gpt-4o` | Yes | Yes | Yes* | Yes* | Varies |
| **LiteLLM** | _(none read; pass `apiKey`)_ | _(none; pass `model`)_ | Yes | Yes* | Yes* | Yes* | Varies |
| **Ollama** | `OLLAMA_BASE_URL` | `llama3.2` | Yes | Partial | Model-dep. | Yes | Free |
| **Claude Code CLI** | _(PATH detection)_ | `claude-sonnet-4-6` | Yes | Yes | Yes | No | Free* |
| **Gemini CLI** | _(PATH detection)_ | `gemini-3.5-flash` | Yes | Partial** | Yes | No | Free* |

*CLI providers use your existing subscription — $0 per token.
**Gemini CLI tool calling uses XML prompt-based parsing (less reliable than native API tool calling).

> **Gemini CLI ToS Warning**: Google's Gemini CLI ToS may prohibit third-party subprocess invocation with OAuth auth. Use `gemini` with API key for production. See [CLI Providers](../getting-started/CLI_PROVIDERS.md) for details.

*OpenRouter, Requesty and LiteLLM capabilities depend on the underlying model selected.

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
3. `ANTHROPIC_API_KEY` → Anthropic
4. `GEMINI_API_KEY` → Google Gemini
5. `GROQ_API_KEY` → Groq
6. `TOGETHER_API_KEY` → Together AI
7. `MISTRAL_API_KEY` → Mistral
8. `XAI_API_KEY` → xAI
9. `REQUESTY_API_KEY` → Requesty
10. `which claude` → Claude Code CLI (PATH detection — no API key, uses Max subscription)
11. `which gemini` → Gemini CLI (PATH detection — no API key, uses Google account)
12. `OLLAMA_BASE_URL` → Ollama

LiteLLM is never auto-detected: name it with `provider: 'litellm'` ([LiteLLM](#litellm)).

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
retryable error: HTTP 401, 402, 403, 429, 500, 502, 503, 504 or 529, a
network failure or request timeout, a primary provider that cannot initialize
(for example a revoked key that its model listing rejects), a request larger
than the model's context window, or a content-policy refusal
([`isRetryableError()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts)).
Fallback is **on by default** with an auto-built chain — to disable it, pass
an empty array.

The chain serves `generateText()` and `streamText()`, and `agent()` and
`agency()` through them. The GMIs of the full runtime (`processRequest()`)
call their provider without a fallback chain; a GMI built with a completion
gateway moves to the next hop when a hop cannot start or an attempt fails
with a retryable error before any output
([Model calls through a completion gateway](../GMI.md#model-calls-through-a-completion-gateway)).

A failover never repeats work the caller already received or that had side
effects. A stream that has delivered text or tool activity is not restarted
on a fallback provider; it ends with an `error` part, so the consumer never
receives a partial answer followed by a second one. A `generateText` call
that already ran native tool rounds continues on the fallback provider from
those rounds (the fallback sees each tool call and its result) instead of
starting over and running the tools again. A call whose prompt-emulated
tools (`toolMode: 'prompt'`) ran throws the error instead of failing over.

Each leg receives the caller's `customModelParams` minus the fields only
another vendor accepts: OpenRouter's routing controls (`provider`, `models`,
`route`, `transforms`) reach only OpenRouter, and Gemini's request fields
(`thinkingConfig`, `topK`, `safetySettings` and the rest of
[`GEMINI_ONLY_PARAM_KEYS`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/openrouter-only-params.ts)) reach only Gemini.

```
Primary provider (e.g., Anthropic)
  ↓ fails with a retryable error
OpenAI gpt-5.6-sol               (if OPENAI_API_KEY is set)
  ↓ fails
OpenRouter openai/gpt-5.6-sol    (if OPENROUTER_API_KEY is set)
  ↓ fails
Gemini gemini-3.1-pro-preview    (if GEMINI_API_KEY is set)
  ↓ fails
Error returned to caller
```

The auto-built chain ([`buildFallbackChain()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts))
takes these legs in this order, each when its key is set, and leaves out the
primary's own provider: OpenAI `gpt-5.6-sol`, Anthropic `claude-sonnet-5-5`
(effort `low`, 1024 tokens of output headroom), OpenRouter
`openai/gpt-5.6-sol`, and Gemini `gemini-3.1-pro-preview` (effort `low`, 1024
tokens of output headroom). Every leg runs with prompt caching off
(`cache: false`). Ollama is not in the auto-built chain; list it in
`fallbackProviders` to use it. For a call whose policy tier is `mature` or
`private-adult`, the chain starts with the policy catalog's fallback ladder for
that tier when `OPENROUTER_API_KEY` is set
([`buildPolicyAwareFallbackChain()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts)).

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
| **$$** (Standard) | Gemini, Mistral, xAI, OpenRouter (varies) | $0.50–$3.00 |
| **$$$** (Premium) | OpenAI, Anthropic | $3.00–$15.00 |

### Cost-Aware Caps

Run limits live on `controls`, and [`agency()`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts) is the surface that checks all of them:

```typescript
import { agency } from '@framers/agentos';

const team = agency({
  provider: 'anthropic',
  agents: {
    researcher: { instructions: 'Find the facts.' },
    writer: { instructions: 'Write the summary.' },
  },
  controls: {
    maxCostUSD: 0.05,           // total cost of a run
    maxTotalTokens: 50_000,     // prompt + completion tokens of a run
    maxDurationMs: 30_000,      // wall-clock time of a run
    maxAgentCalls: 10,          // agent invocations in a run
    onLimitReached: 'error',    // 'stop' | 'warn' | 'error'
  },
  on: {
    limitReached: (e) => console.warn(`${e.metric}: ${e.value} > ${e.limit}`),
  },
});
```

`agency()` compares a run against these limits when the run ends, and compares
the agency's running token and cost totals against them before each new run
starts. A breach calls `on.limitReached`; with `onLimitReached: 'error'` it
throws an `AgencyConfigError` instead. `'stop'` and `'warn'` both report
through the callback, and no limit interrupts a run that is in progress.

`agent()` reads two of the fields, per model call: `controls.maxTotalTokens`
becomes the call's completion-token cap (`maxTokens`) when the agent sets no
`maxTokens`, and `controls.maxDurationMs` becomes the request timeout. It does
not read `maxCostUSD`, `maxAgentCalls` or `onLimitReached`. To cap an agent's
spend, read `result.usage.costUSD` or `agent.usage()` after each call and stop
calling, or track it with
[`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts).

For cheap-first routing across multiple models, attach a custom [`IModelRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/IModelRouter.ts)
via `agent({ router })` — the router decides which provider/model to call per
request. See [Cost Optimization](../safety/COST_OPTIMIZATION.md) for the full guide.

---

## Provider Details

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `gpt-6-astra` | 1.05M | Yes | Yes | Most capable GPT ($10/$50 per MTok) |
| `gpt-6-sol` | 1.05M | Yes | Yes | GPT-6 at $2/$10 per MTok |
| `gpt-6-luna` | 1.05M | Yes | Yes | Cheapest GPT-6 ($0.10/$0.50 per MTok) |
| `gpt-5.6-sol` | 1.05M | Yes | Yes | GPT-5.6 flagship ($4/$20 per MTok) |
| `gpt-4o` | 128K | Yes | Yes | Accepts `temperature` |
| `gpt-4o-mini` | 128K | Yes | Yes | Fast, cheap |
| `gpt-image-1` | n/a | n/a | n/a | Image generation only. OpenAI retires it on 2026-10-23 |

The GPT-5, GPT-6 and o-series models reject `temperature` and `top_p` and require `max_completion_tokens`; the provider handles both. Streamed and non-streamed calls follow one routing rule. The provider sends a call to the Responses API when it goes to a Responses-only model (the `-pro` models, the codex models, `gpt-5.6-cyber` and the deep-research models), when it is a GPT-6 call carrying function tools, or when it is a GPT-5 call carrying function tools and an `effort`; everything else goes to Chat Completions. OpenAI serves GPT-6 tool calls only through Responses (Chat Completions accepts them from Sol and Luna only with `reasoning_effort: "none"`). On the Responses path, `responseFormat` travels as `text.format`, images in user turns and tool results travel as `input_image`, and a streamed call reports its usage on the final chunk. A message part Responses cannot carry, such as audio, fails a call that has no Chat Completions route with `RESPONSES_UNMAPPABLE_CONTENT`. OpenAI retires `o1`, `o1-pro`, `o3-mini` and `o4-mini` on 2026-10-23, and `o3` and `o3-pro` on 2026-12-11.

**OAuth support:** Use your ChatGPT subscription instead of an API key via the device code flow. See [OAuth Auth](./OAUTH_AUTH.md) for details.

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `claude-opus-5-5` | 1M | Yes | Yes | Recommended starting model ($4/$20 per MTok) |
| `claude-fable-5-1` | 1M | Yes | Yes | Most capable ($10/$50 per MTok) |
| `claude-sonnet-5-5` | 1M | Yes | Yes | Current Sonnet ($2/$10 per MTok) |
| `claude-sonnet-5` | 1M | Yes | Yes | Near-Opus coding and agentic work ($2/$10 per MTok) |
| `claude-opus-5` | 1M | Yes | Yes | Previous Opus ($5/$25 per MTok) |
| `claude-sonnet-4-6` | 1M | Yes | Yes | Best value |
| `claude-haiku-4-5-20251001` | 200K | Yes | Yes | Fastest |
| `claude-opus-4-5-20251101` | 200K | Yes | Yes | Legacy Opus, 64K output ($5/$25 per MTok) |

Reasoning-default models (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7`) reject `temperature` and `top_p` with HTTP 400; the provider drops both automatically for these models and sends adaptive thinking when a thinking budget is requested. Claude Opus 5.5, Claude Sonnet 5.5, Claude Mythos 5.1 and the Fable models also reject a forced `tool_choice`, so the provider sends `auto` for them and structured output uses the prompt-based JSON path. Anthropic retired `claude-opus-4-20250514` and `claude-sonnet-4-20250514` on 2026-06-15.

Opus 5 and later, Sonnet 5 and later, Fable and Mythos think by default. Pass `thinking: false` to turn thinking off: the provider sends `{ type: 'between_tools' }` on `claude-sonnet-5-5` and `{ type: 'disabled' }` on `claude-opus-5` and `claude-sonnet-5`, and lowers `effort` to `high` on Sonnet 5.5 and Opus 5, which turn thinking off only at that level or below. `claude-opus-5-5`, the Fable models and Mythos always think; `thinking: false` sends nothing there and logs a warning once. Older models think only when asked, so `thinking: false` leaves the field out. `effort` follows each model's ladder: `claude-opus-4-5` takes `low`, `medium` and `high`, `claude-opus-4-6` and `claude-sonnet-4-6` add `max`, and later models take all five levels; a level a model does not take is sent as `high`. `generateObject` and `streamObject` take the same `thinking` and `effort` options and forward them unchanged; a structured call on a model that thinks by default needs `thinking: false` or room in `maxTokens` for the thinking.

`usage.costUSD` prices cache reads at 0.1x the input price, except Claude Opus 5.5 (0.05x) and Claude Fable 5.1 (0.025x), and cache writes at 1.25x for the 5-minute TTL and 2x for the 1-hour TTL, read from the response's `cache_creation` split.

When Claude declines a request (`stop_reason: "refusal"`), the provider throws an `AnthropicProviderError` with code `content_filter`, whether the refusal came before any output or partway through it. The error carries `stop_details` and any partial text in `details`, and no tool call from the refused turn runs. `generateText` and `streamText` treat it like other content-policy errors: the fallback chain fires, and with `fallbackProviders: []` the call fails. A `streamText` refusal that arrives after text has streamed ends the stream with an `error` part and finish reason `error` instead of falling back, because the refused text has already reached the consumer. Refusals do not count toward the provider-health breaker.

### Google Gemini

```bash
export GEMINI_API_KEY=AIza...
```

The key travels in the `x-goog-api-key` header, never in the request URL, so proxy and access logs do not record it. A comma-separated list of keys rotates per request, and a key that answers HTTP 429 rests while the next request uses another one.

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `gemini-3.1-pro-preview` | 1M | Yes | Yes | Most capable ($2/$12 per MTok, $4/$18 once the prompt passes 200K tokens) |
| `gemini-3.8-flash` | 1M | Yes | Yes | Newest Flash ($0.75/$3.75 per MTok through 2026-12-31, then $1.50/$7.50) |
| `gemini-3.5-flash-lite` | 1M | Yes | Yes | Low-cost Gemini 3 |
| `gemini-2.5-pro` | 1M | Yes | Yes | Previous-generation Pro |
| `gemini-2.5-flash` | 1M | Yes | Yes | Fast, large context |
| `gemini-2.5-flash-lite` | 1M | Yes | Yes | Cheapest ($0.10/$0.40 per MTok) |

Google has retired `gemini-2.0-flash`, `gemini-2.0-flash-lite` and `gemini-1.5-pro`, and requests for them return HTTP 404. A request for `gemini-3.1-pro-preview` that returns 404 is retried once on `gemini-pro-latest`. On `gemini-3.1-pro-preview`, `effort` sets the thinking level (`low`, `medium` or `high`; `xhigh` and `max` send `high`), and other models keep the API default. A `thinkingConfig` object passed through `customModelParams` takes precedence: `thinkingBudget` on Gemini 2.5, `thinkingLevel` on Gemini 3. With `thinkingConfig.includeThoughts`, the model's thought summaries come back on the provider's message as `reasoningText` (streamed as `reasoningTextDelta` chunks), apart from the answer; no provider sends them back. The shared `thinking` option is Anthropic's and Gemini ignores it. Gemini 3 requires its thought signature back on every tool-call turn; the provider captures and replays it, and sends Google's placeholder when a turn has none, such as a call made by another provider in a fallback chain.

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
| `openai/gpt-oss-120b` | 128K | No | Yes | Always reasons |
| `zai-org/GLM-5.3-Flash` | 1M | No | Yes | Thinking on by default |

Together serverless offers no embedding models.

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

### Requesty

```bash
export REQUESTY_API_KEY=...
```

Requesty is an OpenAI-compatible gateway at `https://router.requesty.ai/v1`
(`REQUESTY_BASE_URL` overrides it). Name models as `vendor/model`:

```typescript
import { agent } from '@framers/agentos';

const myAgent = agent({
  provider: 'requesty',
  model: 'anthropic/claude-sonnet-4-5-20250929',
});
```

`provider: 'requesty'` without a model uses `openai/gpt-4o`.

### LiteLLM

[LiteLLM](https://docs.litellm.ai/) is a proxy you host; it exposes the models
you configure on it through an OpenAI-compatible API. AgentOS reaches it with
`provider: 'litellm'` and three explicit fields, because it reads no
environment variable for this provider and has no default model for it:

```typescript
import { generateText } from '@framers/agentos';

const { text } = await generateText({
  provider: 'litellm',
  model: 'anthropic/claude-sonnet-4-6',     // a model name your proxy serves
  apiKey: process.env.LITELLM_API_KEY,      // the proxy's master or virtual key
  baseUrl: 'http://localhost:4000/v1',      // the default when omitted
  prompt: 'Hello',
});
```

`provider: 'litellm'` without `model` throws `Unknown provider "litellm"`, and
without `apiKey` it throws `No API key for litellm`. The provider class has a
default model of its own, `gpt-4o-mini`, used only when the class is driven
directly without a model id; `generateText()`, `streamText()` and `agent()`
never reach it. LiteLLM is not part of
auto-detection or of the auto-built fallback chain; add it to
`fallbackProviders` with its `model`, `apiKey` and `baseUrl` to use it as a
fallback.

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

[`AIModelProviderManager`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts) builds providers from a fixed list of ids, skips
an id it does not know, and has no method that registers another
[`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) class. There are three ways to reach a model the list
does not cover:

1. **An OpenAI-compatible endpoint.** Point the `openai` provider at it with
   `baseUrl` (or `OPENAI_BASE_URL`):

   ```typescript
   import { generateText } from '@framers/agentos';

   const { text } = await generateText({
     provider: 'openai',
     baseUrl: 'https://llm.internal.example.com/v1',
     apiKey: process.env.INTERNAL_LLM_KEY,
     model: 'my-model',
     prompt: 'Hello',
   });
   ```

   The endpoint must answer `GET /models`: the provider lists the models when
   it initializes, and a listing that fails fails the call.

2. **A gateway.** [OpenRouter](#openrouter), [Requesty](#requesty) and a
   self-hosted [LiteLLM](#litellm) proxy each put many vendors behind one
   provider id.

3. **A new provider in AgentOS.** Implement `IProvider` (`providerId`,
   `isInitialized`, `initialize()`, `generateCompletion()`,
   `generateCompletionStream()`, `generateEmbeddings()`,
   `listAvailableModels()`, `getModelInfo()`, `checkHealth()`, `shutdown()`)
   next to the classes under [`src/core/llm/providers/implementations/`](https://github.com/framerslab/agentos/tree/master/src/core/llm/providers/implementations), add
   its id to the manager and to
   [`provider-defaults.ts`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/provider-defaults.ts), and open a pull request.
   [Adding an LLM Provider](../contributing/new-provider.md) lists what a
   provider pull request must include.

The interface is importable for typing as
`import type { IProvider } from '@framers/agentos/core/llm/providers/IProvider'`.

---

## Provider Capabilities Detail

### Tool Calling Support

The Structured Output column is the provider-side enforcement that
`generateObject()` and a session's `responseSchema` request. `generateObject()`
also writes the schema into the system prompt on every provider. A session's
`responseSchema` does not, so on a provider whose entry is "None" the model
never sees the schema and `send()` throws an `ObjectGenerationError` when the
reply is not matching JSON. `streamObject()` sends no provider-side format on
any provider: its schema travels in the system prompt only. All three validate
the reply against the caller's Zod schema.

The Tool Choice column is what the provider does with the `toolChoice` option
(`'auto'`, `'none'`, `'required'`, or `{ type: 'function', function: { name } }`).

| Provider | Structured Output | Tool Choice |
|----------|-------------------|-------------|
| OpenAI | `json_schema` with `strict: true` when the schema fits OpenAI's strict rules, otherwise JSON-object mode | Sent as `tool_choice` |
| Anthropic | A forced tool call whose input is the schema; none on a model that rejects a forced tool choice | `'required'` is sent as `any` and a named function as `tool`; `'none'` is sent as `auto`. A model that rejects a forced choice gets `auto` |
| Gemini | `responseSchema` with JSON output | Not sent; the API default applies |
| OpenRouter | Strict `json_schema` when the schema fits, otherwise JSON-object mode | Sent as `tool_choice`; the routed model decides |
| Requesty | None | Sent as `tool_choice`; the routed model decides |
| Groq, Together, Mistral, xAI, LiteLLM | None | Sent as `tool_choice`; the vendor decides which values it accepts |
| Ollama | None | Not sent |
| Claude Code CLI, Gemini CLI | None | Written into the prompt as an instruction; `'none'` leaves the tool schemas out |

### Embedding Support

| Provider | Models | Dimensions | Batch Size |
|----------|--------|-----------|------------|
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large` | 256–3072 | 2048 |
| Gemini | `gemini-embedding-001`, `gemini-embedding-2` | 3072 | 100 |
| Mistral | `mistral-embed` | 1024 | 512 |
| Ollama | `nomic-embed-text`, `mxbai-embed-large` | 768–1024 | 512 |

---

## Related Documentation

- [Getting Started](../getting-started/GETTING_STARTED.md) — Initial setup and configuration
- [Cost Optimization](../safety/COST_OPTIMIZATION.md) — Budget management and routing
- [Architecture](../architecture/ARCHITECTURE.md) — System architecture overview
- [Structured Output](../orchestration/STRUCTURED_OUTPUT.md) — JSON schema enforcement per provider

## Prompt caching

Provider-side prompt caching (Anthropic explicit breakpoints, OpenAI and
Gemini automatic, OpenRouter forwarding) is on by default with per-call
overrides — see [Prompt Caching](./PROMPT_CACHING.md).
