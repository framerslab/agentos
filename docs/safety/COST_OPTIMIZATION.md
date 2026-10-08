# Cost Optimization

What an AgentOS application spends is set by which model answers, how many tokens each call sends and receives, and how many calls a turn makes. This page lists the controls for each, and how to measure spend before changing anything.

## Measure

Every text call returns its usage:

```typescript
import { generateText } from '@framers/agentos';

const result = await generateText({
  provider: 'openai',
  model: 'gpt-4o-mini',
  prompt: 'Summarize the attached notes in three bullets.',
});

console.log(result.usage);
// { promptTokens, completionTokens, totalTokens, costUSD?, cacheReadTokens?, cacheCreationTokens?, ... }
```

`usage` sums every step of the call, tool rounds included. `costUSD` is set when the provider reports or prices the call and is absent otherwise, so read an absent value as unknown. The cache fields are described in [Prompt Caching](../features/PROMPT_CACHING.md).

An agent keeps a running total for itself and for each session:

```typescript
import { agent } from '@framers/agentos';

const assistant = agent({ provider: 'openai', model: 'gpt-4o-mini' });
const session = assistant.session('user-42');

await session.send('What changed in the last release?');

console.log(await session.usage());   // this session
console.log(await assistant.usage()); // every call this agent made
// { promptTokens, completionTokens, totalTokens, costUSD, calls }
```

These totals live in process memory. To keep them across restarts, turn on the usage ledger, an append-only JSONL file:

```typescript
const assistant = agent({
  provider: 'openai',
  model: 'gpt-4o-mini',
  usageLedger: { enabled: true }, // ~/.framers/usage-ledger.jsonl
  // usageLedger: { enabled: true, path: './usage.jsonl' },
});
```

`generateText()` and `streamText()` take the same `usageLedger` option. Setting `AGENTOS_USAGE_LEDGER_PATH` makes every helper call write to that file without a code change. With `enabled: true`, `usage()` returns the ledger's totals instead of the in-memory tally: a session's total covers the events recorded under its session id, and the agent's total covers every event in the file. Set `enabled: true` whenever a ledger path is in effect, by option or by environment variable, so the in-memory tally and the ledger are not added together.

[`getRecordedAgentOSUsage()`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/usageLedger.ts) reads the same file outside an agent, and `readRecordedAgentOSUsageEvents()` returns the individual events, each with its provider, model, source and session id.

## Limit one call

| Option | Where | Effect |
|--------|-------|--------|
| `maxTokens` | `generateText()`, `streamText()`, `agent()`, `session.send()` | Caps the completion tokens of each model call. |
| `maxSteps` | `generateText()`, `streamText()`, `agent()` | Caps the model calls of one tool loop. `generateText()` and `streamText()` default to 1; `agent()` defaults to 5. |
| `effort` | `generateText()`, `streamText()`, `agent()` | Reasoning depth on models that take it. Lower levels spend fewer reasoning tokens. |
| `thinking` | `generateText()`, `streamText()`, `agent()` | `false` turns extended thinking off on Claude models that allow it ([LLM Providers](../features/LLM_PROVIDERS.md#anthropic)). |
| `history` | `agent()` | Bounds what a session resends on every turn. The default keeps about 120,000 estimated tokens; `history: { maxTokens: 20_000 }` keeps less, and `history: false` keeps none. |

A session sends its whole kept history with each `send()`, so `history.maxTokens` is the main control on the input side of a long conversation.

## Limit a run

`agency()` checks the limits in `controls` against each run:

```typescript
import { agency } from '@framers/agentos';

const team = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  agents: {
    researcher: { instructions: 'Find the facts.' },
    writer: { instructions: 'Write the summary.' },
  },
  controls: {
    maxCostUSD: 0.25,
    maxTotalTokens: 100_000,
    maxDurationMs: 60_000,
    maxAgentCalls: 8,
    onLimitReached: 'error',
  },
  on: {
    limitReached: (e) => console.warn(`${e.metric}: ${e.value} > ${e.limit}`),
  },
});
```

`agency()` compares a run's own totals with the limits when the run ends, and the agency's cumulative token and cost totals with them before each run starts. A breach calls `on.limitReached`; with `onLimitReached: 'error'` it throws an `AgencyConfigError` instead, so an agency whose cumulative cost has passed `maxCostUSD` refuses further runs. No limit interrupts a run in progress.

`agent()` reads two of these fields and applies them to each model call: `controls.maxTotalTokens` becomes `maxTokens` when the agent sets none, and `controls.maxDurationMs` becomes the request timeout. It does not read `maxCostUSD`.

## Budget across calls

[`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts) keeps a per-key spend total for the session and the day and answers whether an operation fits. AgentOS does not call it for you; the host checks before a call and records after it:

```typescript
import { agent, CostGuard } from '@framers/agentos';

const guard = new CostGuard({
  maxSessionCostUsd: 1.0,          // default 1.00
  maxDailyCostUsd: 5.0,            // default 5.00
  maxSingleOperationCostUsd: 0.5,  // default 0.50
});

const assistant = agent({ provider: 'openai', model: 'gpt-4o-mini' });

async function ask(userId: string, prompt: string): Promise<string> {
  const check = guard.canAfford(userId, 0.01); // your estimate for one call
  if (!check.allowed) throw new Error(check.reason);

  const result = await assistant.generate(prompt);
  guard.recordCost(userId, result.usage.costUSD ?? 0);
  return result.text;
}
```

`getSnapshot(key)` returns the current totals and whether a cap is reached, `resetSession(key)` clears the session total, and the daily total resets at local midnight. The totals are in process memory. [Safety Primitives](./SAFETY_PRIMITIVES.md) covers the guard with the circuit breaker and the stuck detector.

## Choose a cheaper model

A provider named without a model uses that provider's default text model (`gpt-4o` for OpenAI, `claude-sonnet-4-6` for Anthropic; [the full table](../features/LLM_PROVIDERS.md#provider-matrix)). Name the model to choose a cheaper one:

```typescript
const assistant = agent({ provider: 'openai', model: 'gpt-4o-mini' });

// One call on a larger model, the rest on the agent's model:
const hard = await assistant.generate('Work through this proof.', { model: 'gpt-4o' });
```

To choose per request in code, pass a `router`. `generateText()`, `streamText()` and `agent()` call its `selectModel()` at the start of a call with the task hint, required capabilities and `routerParams`, and use the provider and model it returns. A router that returns `null` or throws leaves the configured model in place. [`IModelRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/IModelRouter.ts) is the interface, and [`ModelRouter`](https://github.com/framerslab/agentos/blob/master/src/core/llm/routing/ModelRouter.ts) is a rule-based implementation.

Two providers cost nothing per token: the [CLI providers](../getting-started/CLI_PROVIDERS.md) run on a Claude or Google subscription, and Ollama runs models on your own hardware.

## Know what a fallback costs

When a call fails with a retryable error, the fallback chain retries it on another provider. The chain AgentOS builds from the environment uses flagship models: `gpt-5.6-sol` on OpenAI and OpenRouter, `claude-sonnet-5-5` on Anthropic and `gemini-3.1-pro-preview` on Gemini ([Fallback Behavior](../features/LLM_PROVIDERS.md#fallback-behavior)). A primary on a small model can therefore fail over to a model that costs many times more per token. Set the chain yourself to keep fallbacks in the same price class, or pass an empty array to turn fallback off:

```typescript
const assistant = agent({
  provider: 'openai',
  model: 'gpt-4o-mini',
  fallbackProviders: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }],
  onFallback: (error, provider) => console.warn(`fell back to ${provider}: ${error.message}`),
});
```

## Send fewer tokens

- **Prompt caching** is on by default: stable prompt prefixes are billed at the provider's cache-read rate on later calls. [Prompt Caching](../features/PROMPT_CACHING.md) covers the per-provider behavior and the `cache` option, and [Cache Diagnostics](../features/CACHE_DIAGNOSTICS.md) explains a cache miss.
- **Capability discovery**, on the full runtime, replaces a prompt that lists every tool schema with a per-turn selection ([Capability Discovery](../extensions/CAPABILITY_DISCOVERY.md)).
- **Memory routing** picks the retrieval, ingest and reader strategy per message, with presets that trade accuracy against cost: [Memory Router](../MEMORY_ROUTER.md), [Ingest Router](../INGEST_ROUTER.md) and [Read Router](../READ_ROUTER.md).

## Related

- [LLM Providers](../features/LLM_PROVIDERS.md): providers, default models and the fallback chain
- [Prompt Caching](../features/PROMPT_CACHING.md)
- [Safety Primitives](./SAFETY_PRIMITIVES.md)
- [Evaluation Guide](../observability/EVALUATION.md): measure quality before moving to a cheaper model
