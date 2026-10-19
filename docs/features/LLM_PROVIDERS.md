# LLM Providers — multi-provider configuration & routing

AgentOS abstracts every LLM behind a single [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface. Thirteen providers are wired in directly: eleven reached with an API key or a base URL, and two local CLI bridges that ride an existing Claude Max or Google account subscription. Three of the thirteen are gateways: OpenRouter and Requesty route to models from many vendors, and LiteLLM is a proxy you host. Every provider speaks the same streaming protocol, supports the same tool-call shape (with the documented exceptions below), and reports each call's token usage in the same shape; [Prices and Cost Reporting](#prices-and-cost-reporting) says which providers also report the call's cost. The fallback chain is auto-built from whichever keys are set in the environment and is overridable per agent.

---

## Table of Contents

1. [Overview](#overview)
2. [Provider Matrix](#provider-matrix)
3. [Quick Start](#quick-start)
4. [Auto-Detection Order](#auto-detection-order)
5. [Provider Configuration](#provider-configuration)
6. [Fallback Behavior](#fallback-behavior)
7. [Prices and Cost Reporting](#prices-and-cost-reporting)
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
- **Cost-aware caps**: `agency()` checks `controls.maxCostUSD` and the other run limits after each run; `agent()` applies `controls.maxTotalTokens` and `controls.maxDurationMs` to each model call; a `budget` on `generateText()`, `streamText()`, `generateObject()`, `embedText()` or `agent()` checks each provider call against a spend cap before it is sent; a custom router sends requests to cheaper models
- **Streaming**: All providers support streaming with a unified async iterator
- **Tool calling**: Unified function/tool calling across providers that support it

---

## Provider Matrix

| Provider | Env Var | Default Model | Streaming | Tool Calling | Vision | Embedding | Default model's price (input / output, USD per 1M tokens) |
|----------|---------|---------------|-----------|--------------|--------|-----------|-----------|
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o` | Yes | Yes | Yes | Yes | $2.50 / $10.00 |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | Yes | Yes | Yes | No | $3.00 / $15.00 |
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | Yes | Yes | Yes | Yes | $0.30 / $2.50 |
| **Groq** | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Yes | Yes | No | No | Enterprise contracts only |
| **Together** | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Yes | Yes | No | No | $1.04 / $1.04 |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-large-latest` | Yes | Yes | No | Yes | $0.50 / $1.50 |
| **xAI** | `XAI_API_KEY` | `grok-2` | Yes | Yes | Yes | No | Not on xAI's model list |
| **OpenRouter** | `OPENROUTER_API_KEY` | `openai/gpt-4o` | Yes | Yes | Yes* | Yes* | $2.50 / $10.00 |
| **Requesty** | `REQUESTY_API_KEY` | `openai/gpt-4o` | Yes | Yes | Yes* | Yes* | $2.50 / $10.00 |
| **LiteLLM** | _(none read; pass `apiKey`)_ | _(none; pass `model`)_ | Yes | Yes* | Yes* | Yes* | Your proxy's upstream prices |
| **Ollama** | `OLLAMA_BASE_URL` | `llama3.2` | Yes | Partial | Model-dep. | Yes | Free |
| **Claude Code CLI** | _(PATH detection)_ | `claude-sonnet-4-6` | Yes | Yes | Yes | No | Free* |
| **Gemini CLI** | _(PATH detection)_ | `gemini-3.5-flash` | Yes | Partial** | Yes | No | Free* |

Prices are the vendors' list prices, read on 2026-10-12; [Prices and Cost Reporting](#prices-and-cost-reporting) links each source.

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

For a provider that rotates keys, the key variable (or the `apiKey` you pass) may hold a comma-separated list: a key pool. The LLM providers move a request to the next usable key when one is revoked, unpaid or throttled, probe a failed key before it returns, and persist the keys' standing when given a store; `AGENTOS_KEY_POOL_STRATEGY=ordered` uses the keys in the order given (credited keys first, the paid key last). [API Key Rotation](../KEY_ROTATION.md) has the strategies, the failure kinds, and the providers that need a single key.

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
An agent created with `runtime: 'gmi'` builds that gateway from its own
`fallbackProviders` (unset, the same auto-built chain), `policyTier`, `router`
and `onFallback`, so its sessions fall back as a gateway does: before a step's
first output, and not after it
([GMIs from agent()](../GMI.md#gmis-from-agent)).

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

With `planning` on, the planning call carries the caller's messages, so it
takes OpenRouter's routing controls and `plugins` from `customModelParams`: a
`provider.data_collection: 'deny'` or a context-compression plugin set for
the turn holds for it too. The other keys, such as `max_tokens` or
`response_format`, go to the turn's requests alone.

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

## Prices and Cost Reporting

Every provider reports each call's token usage. Whether the result also carries the call's cost, `usage.costUSD`, depends on the provider:

| Provider | `usage.costUSD` |
|----------|-----------------|
| OpenAI, Anthropic, Gemini | Priced from the provider's own table of the vendor's list prices ([`openaiPricing.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/openaiPricing.ts), [`anthropicCatalog.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/anthropicCatalog.ts), [`GeminiProvider.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/GeminiProvider.ts)). A model the table has no row for reports no cost. |
| OpenRouter, Requesty | The cost the gateway returns with the response |
| Ollama, Claude Code CLI, Gemini CLI | `0` |
| Groq, Together, Mistral, xAI, LiteLLM | These providers send their calls through the OpenAI provider, which prices a call from OpenAI's table ([`openaiPricing.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/openaiPricing.ts)) by the model id the response names, exact or with a trailing `-YYYY-MM-DD` removed; an id the table has no row for reports no cost. The table lists only OpenAI's models, so a call to the default model of Groq, Together, Mistral or xAI reports no cost, and a LiteLLM call whose response names an OpenAI model, such as `gpt-4o-mini`, is priced at OpenAI's list price. |

Prices for a host: `openAIModelPricing(modelId)` and `anthropicModelPricing(modelId)`, exported from `@framers/agentos/safety/runtime` and from the package root with the types `OpenAIModelPrice` and `AnthropicModelPrice`, give a spend guard a call's list price in USD per 1K tokens before the call is made, without loading a provider: `{ input, output }` for OpenAI and `{ input, output, cacheRead, longContext? }` for Claude. `anthropicModelPricing` resolves an exact catalog id, a dated snapshot of a bare id (`claude-sonnet-5-5-20261001`) and the bare alias of a dated row (`claude-opus-4-5`), and answers `undefined` for any other id (`claude-opus-4`, `claude-sonnet-4`, `claude`), never a prefix guess; a retired snapshot (`claude-opus-4-20250514`) prices by its exact id alone. `longContext` is present on a model priced by prompt length (Claude Haiku 5.5: `{ fromTokens: 100000, input, output, cacheRead }`) and names the prompt size above which its long `input`, `output` and `cacheRead` rates apply; `estimateAnthropicCostUSD` bills a response whose prompt, cached tokens included, is over that size at the same long rates.

The list prices of the default text models, in USD per 1M tokens, as each vendor's page gave them on 2026-10-12. Each vendor's other models cost more or less; the linked pages list them.

| Provider | Default text model | Input | Output | Source |
|----------|--------------------|-------|--------|--------|
| Ollama | `llama3.2` | 0 | 0 | Runs on your machine |
| Claude Code CLI | `claude-sonnet-4-6` | 0 | 0 | Uses your existing subscription |
| Gemini CLI | `gemini-3.5-flash` | 0 | 0 | Uses your existing subscription |
| Gemini | `gemini-2.5-flash` | $0.30 ($1.00 for audio) | $2.50, thinking included | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Mistral | `mistral-large-latest` (Mistral Large 3) | $0.50 | $1.50 | [Mistral Large 3](https://docs.mistral.ai/models/mistral-large-3-25-12) |
| Together | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | $1.04 | $1.04 | [Together AI pricing](https://www.together.ai/pricing) |
| OpenAI | `gpt-4o` | $2.50 | $10.00 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| OpenRouter | `openai/gpt-4o` | $2.50 | $10.00 | [OpenRouter: GPT-4o](https://openrouter.ai/openai/gpt-4o) |
| Requesty | `openai/gpt-4o` | $2.50 | $10.00 | [Requesty model list](https://router.requesty.ai/v1/models) |
| Anthropic | `claude-sonnet-4-6` | $3.00 | $15.00 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Groq | `llama-3.3-70b-versatile` | On request | On request | [Groq models](https://console.groq.com/docs/models): enterprise contracts only ([Groq](#groq)) |
| xAI | `grok-2` | Not listed | Not listed | [xAI models](https://docs.x.ai/developers/models) ([xAI](#xai-grok)) |
| LiteLLM | none; pass `model` | Your proxy's upstream | Your proxy's upstream | |

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
spend, give it a `budget` (`agent({ budget: { maxCostUSD: 0.25 } })`): each
provider call of its `generate()`, `stream()` and sessions is checked against
what is left before it is sent, and by default a call whose estimated cost
would pass the cap is refused with `CostCapExceededError`. The budget holds its
spending in a
[`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts)
([Cost Optimization](../safety/COST_OPTIMIZATION.md#a-spend-budget-for-a-run-of-calls)).

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
| `gpt-image-2.5-flare` | n/a | n/a | n/a | Image generation only: the `generateImage()` default |
| `gpt-image-2.5-sunburst` | n/a | n/a | n/a | Image editing: the `editImage()`, `variateImage()` and `transferStyle()` default |

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

Reasoning-default models (`claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7`) reject `temperature` and `top_p` with HTTP 400; the provider drops both automatically for these models and sends adaptive thinking when a thinking budget is requested. Claude Opus 5.5, Claude Sonnet 5.5, Claude Mythos 5.1 and the Fable models also reject a forced `tool_choice`, so the provider sends `auto` for them; a schema request on these models takes the native JSON output format (`output_config.format`, see Tool Calling Support below) when the schema fits the format's limits, and the provider's own schema block in the system prompt when it does not. Every other Claude model accepts a forced `tool_choice`, so a schema the format cannot carry goes to it as a forced tool call. Anthropic retired `claude-opus-4-20250514` and `claude-sonnet-4-20250514` on 2026-06-15 (the API answers 404 for both; the catalog keeps them as `deprecated`); a schema request on those two ids takes the forced tool.

Opus 5 and later, Sonnet 5 and later, Fable and Mythos think by default. Pass `thinking: false` to turn thinking off: the provider sends `{ type: 'between_tools' }` on `claude-sonnet-5-5` and `{ type: 'disabled' }` on `claude-opus-5` and `claude-sonnet-5`, and lowers `effort` to `high` on Sonnet 5.5 and Opus 5, which turn thinking off only at that level or below. `claude-opus-5-5`, the Fable models and Mythos always think; `thinking: false` sends nothing there and logs a warning once. Older models think only when asked, so `thinking: false` leaves the field out. `effort` follows each model's ladder: `claude-opus-4-5` takes `low`, `medium` and `high`, `claude-opus-4-6` and `claude-sonnet-4-6` add `max`, and later models take all five levels; a level a model does not take is sent as `high`. `generateObject` and `streamObject` take the same `thinking` and `effort` options and forward them unchanged; a structured call on a model that thinks by default needs `thinking: false` or room in `maxTokens` for the thinking.

`usage.costUSD` prices cache reads at 0.1x the input price, except Claude Opus 5.5 and Claude Sonnet 5.5 (0.05x) and Claude Fable 5.1 (0.025x), and cache writes at 1.25x for the 5-minute TTL and 2x for the 1-hour TTL, read from the response's `cache_creation` split.

When Claude declines a request (`stop_reason: "refusal"`), the provider throws an `AnthropicProviderError` with code `content_filter`, whether the refusal came before any output or partway through it. The error carries `stop_details` and any partial text in `details`, and no tool call from the refused turn runs. `generateText` and `streamText` treat it like other content-policy errors: the fallback chain fires, and with `fallbackProviders: []` the call fails. A `streamText` refusal that arrives after text has streamed ends the stream with an `error` part and finish reason `error` instead of falling back, because the refused text has already reached the consumer. Refusals do not count toward the provider-health breaker.

### Google Gemini

```bash
export GEMINI_API_KEY=AIza...
```

The key travels in the `x-goog-api-key` header, never in the request URL, so proxy and access logs do not record it. A comma-separated list of keys is a key pool: a key that answers HTTP 429, or the 400 that names an invalid key, is taken out and the request moves to the next usable key at once; a streaming request marks the key and the next request draws another.

| Model | Context | Vision | Tool Calling | Notes |
|-------|---------|--------|-------------|-------|
| `gemini-3.1-pro-preview` | 1M | Yes | Yes | Most capable ($2/$12 per MTok, $4/$18 once the prompt passes 200K tokens) |
| `gemini-3.8-flash` | 1M | Yes | Yes | Newest Flash ($0.75/$3.75 per MTok through 2026-12-31, then $1.50/$7.50) |
| `gemini-3.5-flash-lite` | 1M | Yes | Yes | Low-cost Gemini 3 |
| `gemini-2.5-pro` | 1M | Yes | Yes | Previous-generation Pro |
| `gemini-2.5-flash` | 1M | Yes | Yes | Fast, large context |
| `gemini-2.5-flash-lite` | 1M | Yes | Yes | Cheapest ($0.10/$0.40 per MTok) |

Google has retired `gemini-2.0-flash`, `gemini-2.0-flash-lite` and `gemini-1.5-pro`, and requests for them return HTTP 404. A request for `gemini-3.1-pro-preview` that returns 404 is retried once on `gemini-pro-latest`. On `gemini-3.1-pro-preview`, `effort` sets the thinking level (`low`, `medium` or `high`; `xhigh` and `max` send `high`), and other models keep the API default. A `thinkingConfig` object passed through `customModelParams` takes precedence: `thinkingBudget` on Gemini 2.5, `thinkingLevel` on Gemini 3. With `thinkingConfig.includeThoughts`, the model's thought summaries come back on the provider's message as `reasoningText` (streamed as `reasoningTextDelta` chunks), apart from the answer; no provider sends them back. The shared `thinking` option is Anthropic's and Gemini ignores it. Gemini 3 requires its thought signature back on every tool-call turn; the provider captures and replays it, and sends Google's placeholder when a turn has none, such as a call made by another provider in a fallback chain.

Images go to Gemini in two ways. A data URL is sent inline, read as WHATWG Fetch reads it, and a request carries at most 100 MB of inline data counted in base64 ([Google's file limits](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-new-file-limits/)). An https URL is sent as `fileData`, and Gemini fetches it itself, up to 15 MB a file ([file input methods](https://ai.google.dev/gemini-api/docs/file-input-methods)); the provider fetches nothing. An http URL, a malformed data URL and too much inline data are refused before the request, with HTTP status 400, so they count as the caller's error and not against Gemini's health. A prompt Gemini blocks (`promptFeedback.blockReason`) and an answer its filters stop with no content (`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` and the `IMAGE_` reasons) throw a `content_filter` error that names the reason.

### Groq

```bash
export GROQ_API_KEY=gsk_...
```

`provider: 'groq'` without a model uses `llama-3.3-70b-versatile`. Groq shut that model and `llama-3.1-8b-instant` down for its free and developer plans on 2026-08-16 and serves them only under enterprise contracts, and it shut `mixtral-8x7b-32768` down on 2025-03-20 ([Groq deprecations](https://console.groq.com/docs/deprecations), read 2026-10-12). On other plans, name a model from [Groq's model list](https://console.groq.com/docs/models), such as `openai/gpt-oss-120b`, which Groq recommends in place of Llama 3.3 70B ($0.15 input and $0.60 output per 1M tokens on 2026-10-12):

```typescript
import { generateText } from '@framers/agentos';

const { text } = await generateText({
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  prompt: 'Hello',
});
```

Groq runs its models on its own LPU hardware; its model list gives each model's speed in tokens per second.

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
| `mistral-large-latest` | 256K | No | Yes | Mistral Large 3 (`mistral-large-2512`); the default |
| `codestral-latest` | 128K | No | Yes | Codestral (`codestral-2508`), for code |
| `mistral-small-latest` | 256K | No | Yes | Mistral Small 4 (`mistral-small-2603`) |

Each alias's model and context window are from its page in [Mistral's model list](https://docs.mistral.ai/models), read 2026-10-12.

### xAI (Grok)

```bash
export XAI_API_KEY=xai-...
```

`provider: 'xai'` without a model uses `grok-2`. [xAI's model list](https://docs.x.ai/developers/models) names neither `grok-2` nor `grok-2-mini` on 2026-10-12, so name a model from that list.

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
`responseSchema`, on either agent runtime, writes it there only when the
provider-side format carries no schema: on a provider whose entry is "None",
on an Anthropic model whose schema neither the JSON output format nor a forced
tool carries (a record schema on a model that refuses a forced tool choice), and
in JSON-object mode. Each fallback provider is checked for its
own format. `streamObject()` sends no provider-side format on any provider: its
schema travels in the system prompt only. All three validate the reply against
the caller's Zod schema, and `send()` throws an `ObjectGenerationError` when the
reply is not matching JSON.

On Anthropic, `anthropicSchemaRoute(modelId, schema)`
([`model-strict-tool-use.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/model-strict-tool-use.ts))
picks one of three routes for the model and the schema. The native JSON output
format (`output_config.format` with `type: json_schema`) goes to every model
that has it (Opus 4.5 and later, Sonnet 4.5 and later, Haiku 4.5 and later,
Fable, Mythos) when the schema fits the vendor's limits: an object root with
properties, `additionalProperties: false` on every object (stamped on the wire
copy), no `$ref`, `oneOf`, `not` or record, at most 16 union-typed and 24
optional properties. `minLength`, `maxLength` and `pattern` go out as written;
`minItems` above 1, `maxItems`, numeric bounds and a `format` outside the
vendor's list are stripped from the wire copy, and the caller's Zod schema
re-validates the answer with every constraint. The model answers JSON in its
text block; the format rides with adaptive thinking and beside a direct
caller's tools, with no beta header, and the vendor's union-typed and optional
property limits count a direct caller's `strict: true` tools with the format's
schema. A forced tool call whose input is the schema, sent without `strict` and
with `tool_choice` forced on it, carries a schema the format cannot carry (a
record, say) on every model that accepts a forced tool choice, Claude Sonnet
4.6 (the provider's default text model), Opus 4.5 to 4.8, Opus 5, Sonnet 4.5,
Sonnet 5, Haiku 4.5 and Haiku 5.5 among them. It carries every schema on Claude
Opus 4 and Claude Sonnet 4 (the May 2025 ids, retired on 2026-06-15), which have
no JSON output format. A passthrough `customModelParams.tools` array replaces the
schema tool, so it must hold a tool of the schema's name for the forced choice
to go out; without one the schema rides the prompt. When neither route carries
the schema (such a schema on Claude Opus 5.5, Sonnet 5.5, Fable or Mythos 5.1,
which refuse a forced tool choice), and when a request on the forced-tool route
turns thinking on, which a forced tool choice cannot ride beside, the provider
puts the schema into the system prompt itself as one block after the caller's
("Answer with JSON only, matching this schema: ...") and warns once per model
and reason; the schema tool is never sent clamped to `auto`. A request that enables citations leaves the format, which the API
refuses beside citations, for the forced tool, or for the prompt on a model
that refuses a forced choice. Every completion and stream chunk of a schema
request names the route it took (`schemaRoute`), and one whose schema rode the
prompt says `schemaInPayload: false`, so a completion gateway lifts the answer
from where the request put it. A cut-off answer (`max_tokens`) keeps
`finishReason: 'length'`: `generateObject()` raises its output budget and asks
again, and a session's `send()` rejects naming the cut-off. Two cautions from
the vendor's page: a schema property that asks
for the model's reasoning may draw a refusal, and the capitalization of `enum`
and `const` values is not guaranteed, so `generateObject()` repairs an enum or
literal value that differs from the schema's only by case once before it spends
a retry.

The Tool Choice column is what the provider does with the `toolChoice` option
(`'auto'`, `'none'`, `'required'`, or `{ type: 'function', function: { name } }`).

| Provider | Structured Output | Tool Choice |
|----------|-------------------|-------------|
| OpenAI | `json_schema` with `strict: true` when the schema fits OpenAI's strict rules, otherwise JSON-object mode | Sent as `tool_choice` |
| Anthropic | The native JSON output format (`output_config.format`) on every model that has it and whose schema fits its limits; a non-strict forced tool call whose input is the schema for a schema the format cannot carry on a model that accepts a forced choice, and for every schema on Claude Opus 4 and Sonnet 4; the provider's own schema block in the system prompt when neither carries the schema or thinking is on | `'required'` is sent as `any` and a named function as `tool`; `'none'` is sent as `auto`. A model that rejects a forced choice gets `auto` |
| Gemini | `responseSchema` with JSON output | Not sent; the API default applies |
| OpenRouter | Strict `json_schema` when the schema fits, otherwise JSON-object mode. When OpenRouter finds no endpoint that serves the strict schema (HTTP 404, "No endpoints found"), the request is sent once more in JSON-object mode with the schema written into its system prompt, unless the system prompt states a schema already | Sent as `tool_choice`; the routed model decides |
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
- [API Key Rotation](../KEY_ROTATION.md): comma-separated key lists as a pool, the strategies, failover and probes, and which providers need a single key
- [CLI Error Codes](./CLI_ERROR_CODES.md): the errors the Claude Code and Gemini CLI providers raise

## Prompt caching

Provider-side prompt caching (Anthropic explicit breakpoints, OpenAI and
Gemini automatic, OpenRouter forwarding) is on by default with per-call
overrides — see [Prompt Caching](./PROMPT_CACHING.md).
