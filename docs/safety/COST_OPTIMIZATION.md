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

`agent()` reads two of these fields and applies them to each model call: `controls.maxTotalTokens` becomes `maxTokens` when the agent sets none, and `controls.maxDurationMs` becomes the request timeout. It does not read `maxCostUSD`; its `budget` option caps its spend ([A spend budget for a run of calls](#a-spend-budget-for-a-run-of-calls)).

## Budget across calls

[`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts) keeps a per-key spend total for the session and the day and answers whether an operation fits. Given a `budget` ([A spend budget for a run of calls](#a-spend-budget-for-a-run-of-calls)), `generateText()`, `streamText()`, `generateObject()` and `embedText()` check each provider call against it before the call is sent and record the call's cost in it afterwards, and `agent()` does the same for the calls of its `generate()`, `stream()` and sessions. Without one, the host calls the guard itself, checking before a call and recording after it:

```typescript
import { agent, CostGuard } from '@framers/agentos';

const guard = new CostGuard({
  maxSessionCostUsd: 1.0,          // default 1.00
  maxDailyCostUsd: 5.0,            // default 5.00
  maxSingleOperationCostUsd: 0.5,  // default 0.50
});

const assistant = agent({ provider: 'openai', model: 'gpt-4o-mini' });

const ESTIMATED_COST_USD = 0.01; // a conservative estimate for one call

async function ask(userId: string, prompt: string): Promise<string> {
  const check = guard.canAfford(userId, ESTIMATED_COST_USD);
  if (!check.allowed) throw new Error(check.reason);

  const result = await assistant.generate(prompt);
  // An absent costUSD means the cost is unknown, not zero: record the estimate.
  guard.recordCost(userId, result.usage.costUSD ?? ESTIMATED_COST_USD);
  return result.text;
}
```

`canAfford()` and `recordCost()` are separate calls, so two calls for one key that run at the same time can both pass the check before either records its cost. When a cap must hold exactly, run one call per key at a time. `getSnapshot(key)` returns the current totals and whether a cap is reached, `resetSession(key)` clears the session total, and the daily total resets at local midnight. The totals are in process memory. [Safety Primitives](./SAFETY_PRIMITIVES.md) covers the guard with the circuit breaker and the stuck detector.

## A spend budget for a run of calls

`generateText()`, `streamText()`, `generateObject()`, `embedText()` and `agent()` take a `budget`: a cap in US dollars, and optionally in tokens, on the provider calls they make. Before each provider call, the budget prices the call at the model's listed rates, counting one prompt token for every four characters of its messages and of the tool definitions it sends (of an embedding, its input) and the call's `maxTokens` of output, held to the model's output ceiling where a lower one is known (16,384 tokens for `gpt-4o`, as the request is sent), or 4,096 when the call sets none or sets `NaN` (an embedding has no output), and refuses the call when that estimate would take what the budget has spent past `maxCostUSD`. After the call, it records the cost the provider reported, or else (when it reports none, or one that is not a number zero or more) the call's tokens at the listed rates: a stream is charged what its chunks reported, and a request that fails is charged what its error reports it was billed. A refused call is never sent. It is not tried on a fallback provider or in another `generateObject()` attempt, and it does not count against the provider's health. The check uses the estimate and the record uses the reported cost, so a call that costs more than its estimate can take the total past `maxCostUSD`, and every later call is then refused.

Pass one `SpendBudget` to every call that should share it. Settings in its place (`budget: { maxCostUSD: 0.25 }`) make a budget for that one call, its steps, `generateObject()` attempts and fallback hops included. On `agent()` they make one budget that the agent and all its sessions share, and a `budget` passed to the agent's `generate()` or `stream()` replaces it for that call. `spentUSD()` reads the dollars spent under the budget's id, and `tokensUsed()` the tokens it has counted. A `maxCostUSD` or a `maxTotalTokens` below zero, or one that is not a number, throws a `RangeError`, and `agent({ runtime: 'gmi' })` throws when it is given a budget, since the GMI runtime's model calls do not pass through these helpers.

```ts
import { agent, SpendBudget, CostCapExceededError } from '@framers/agentos';

const budget = new SpendBudget({ maxCostUSD: 0.25, onLimitReached: 'throw' });
const helper = agent({ provider: 'openai', model: 'gpt-6-luna', budget });
const session = helper.session('call-42');
session.recordExternalCost(0.003, { kind: 'stt' }); // a minute of speech-to-text billed outside AgentOS
try {
  await session.send('Summarise the last ten minutes.');
} catch (error) {
  if (error instanceof CostCapExceededError) {
    // the run is out of budget: the call was refused before it was made
  }
}
```

`session.recordExternalCost(usd, { kind })` charges a cost made outside AgentOS, such as speech-to-text billed by the minute, to the agent's budget. A cost of zero or below records nothing, and a cost that is not a number throws a `RangeError`, since a cost left uncounted would let the run spend past its cap. On an agent without a budget the call does nothing. A refusal rejects a call to `generateText()`, `generateObject()`, `embedText()`, an agent's `generate()` or a session's `send()` with its error; a stream from `streamText()` or from an agent ends its `fullStream` with an `error` part that carries it.

**The shared guard.** A budget keeps its dollar total in a [`CostGuard`](https://github.com/framerslab/agentos/blob/master/src/safety/runtime/CostGuard.ts) under its id: `budgetId`, or one it makes when none is given. Without a `guard` option, the budget makes its own guard, capped only by `maxCostUSD`. Given a `guard`, it sets the session cap the guard holds for its id to `maxCostUSD` and keeps the id's daily cap: one set for that id with `setAgentLimits()`, or else the guard's own. The guard's other caps apply to its calls too: `maxSingleOperationCostUsd` to each call's estimate, and the daily cap to the id's total for the day, which resets at the process's local midnight (a `new CostGuard()` caps a call at 0.50 US dollars and a day at 5.00). Budgets made on one guard with one `budgetId` share one total, so a run split across several calls or several agents stops at one cap. As with a guard called by hand, the check and the record are separate steps: two calls that run at the same time can both pass the check before either records its cost. The guard's totals live in process memory; [a day's bound](#a-days-bound-across-processes) holds a cap across processes.

**`maxTotalTokens`** caps the prompt and completion tokens the budget counts. A call is refused with `CostCapExceededError` when the tokens counted so far plus its estimate (its prompt and its `maxTokens` of output, counted as above) would pass the cap, and after the call the tokens the provider reported are counted; a count reported as `NaN` counts as none. Each `SpendBudget` instance keeps its own count, so budgets that share a guard and a `budgetId` share their dollars but not their tokens. It is separate from `controls.maxTotalTokens`, which `agent()` applies as each call's `maxTokens` when the agent sets none.

**`onLimitReached`** decides what the budget does with a call it would refuse. `'throw'`, the default, refuses it: with `CostCapExceededError` at a cap, and with `UnpricedModelError` for a model with no price row. `'warn'` logs a warning and lets the call run, and the budget records the call afterwards as usual. A function is called with a `SpendLimitInfo` (the budget's id; the cap, one of `session`, `daily`, `single_operation`, `tokens` and `unpriced`; the call, such as `generate_text.step`, `stream_text` or `embed_text`; and the reason), and the call is then refused as with `'throw'`.

**`unpriced`** decides what happens to a call on a model with no price row. The rows are OpenAI's, the table `OpenAIProvider` prices its calls with (a dated snapshot without a row of its own takes its base model's), so a call to any other provider, or to an OpenAI model without a row, has no estimate. `'refuse'`, the default, refuses it before it is sent with `UnpricedModelError`, which names the provider and the model, because its cost could not be counted. `'allow'` lets it run and checks it as costing nothing: the token cap still applies, a budget already past `maxCostUSD` still refuses it, and a cost the provider reports for it is recorded after the call.

**`hookErrors`** decides what an error thrown by `onBeforeGeneration`, `onAfterGeneration` or `onBeforeToolExecution` does, on `generateText()` and `streamText()` and, per call, on an agent's `generate()` and `stream()`. `'warn'`, the default, logs it and the call goes on. `'throw'` ends the call with that error, so a guard written as a hook can stop a call, and a tool whose `onBeforeToolExecution` hook throws does not run. A call a hook stops, like one the budget refuses, is not tried on a fallback provider and does not count against the provider's health.

## A day's bound across processes

A budget and a `CostGuard` keep their totals in one process's memory. To hold a day's spending under a cap across processes and restarts, a service reserves each admission's largest cost before it starts and settles it once its use is known, in a store it keeps on its own tables. `reserveSpend(store, admission)` has the store lock the UTC day the admission starts in and read that day's committed total, its open reservations plus its settled ones. When the total plus the admission's `micro` would pass its `capMicro`, it throws `CostCapExceededError` with the cap type `daily` and reserves nothing; otherwise it records the reservation and returns its id. `releaseSpend(store, id, settledMicro, at)` settles a reservation once, at what its use cost and never above the amount reserved, and returns `false` when the reservation is already settled or unknown. `releaseExpiredSpend(store, at)` settles, at its whole amount, each open reservation whose time is up at `at`, since its use was never confirmed, and returns how many it settled; a service runs it on a timer. The store is a `SpendDayStore`, four methods that each run inside the caller's transaction:

- `lockDay(day)` makes the day's row when it is missing, locks it for the transaction and returns the committed total. The lock is what keeps two admissions in different processes from reading the same total.
- `addReservation(reservation)` records a reservation, adds its amount to the day's open total and returns its id.
- `settleReservation(id, settledMicro, at)` settles an open reservation once: it takes the reservation's amount off the open total and adds what it settled at, held to that amount, to the settled total. It returns `false`, changing nothing, for a reservation already settled or unknown.
- `expiredReservations(at)` lists the open reservations whose time is up.

`InMemorySpendDayStore` keeps the rows in memory and takes no lock, so two admissions awaited at the same time can both read the same total: it is for tests and for a process that admits one reservation at a time.

Each admission names its own cap in `capMicro`: the whole day's limit, or a share of it for one class of admission. Every admission is checked against the same committed total, so an admission of a class given a lower cap (sessions on a free plan, say) is refused once it would take the day's total past that share, while admissions given the whole limit are admitted until the total would pass the limit.

```ts
import { InMemorySpendDayStore, minutesMicro, openAITranscriptionPricing, releaseSpend, reserveSpend, toMicro } from '@framers/agentos';

const store = new InMemorySpendDayStore(); // a service implements SpendDayStore on its own tables, locking the day's row
const usdPerMinute = openAITranscriptionPricing('gpt-4o-mini-transcribe');
if (usdPerMinute === undefined) throw new Error('no price for the transcription model');
const at = new Date();
const id = await reserveSpend(store, {
  kind: 'session',
  micro: minutesMicro(3600, toMicro(usdPerMinute)), // an hour, the most the session can run
  at,
  expires: new Date(at.getTime() + 3_600_000),
  capMicro: 60_000_000, // 60 US dollars a day; a CostCapExceededError ('daily') past it, with nothing reserved
});
// ... the session ends after 754 seconds ...
await releaseSpend(store, id, minutesMicro(754, toMicro(usdPerMinute)), new Date());
```

Amounts are whole micro-dollars, millionths of a US dollar. `toMicro(usd)` converts dollars, rounded to the micro-dollar. `minutesMicro(seconds, microPerMinute)` prices seconds at a rate per minute, and `tokensMicro(promptTokens, outputTokens, price)` prices tokens at a price row in US dollars per 1,000 tokens, both rounding up. `minutesMicro` throws a `RangeError` for a rate that is not a whole number of micro-dollars, zero or more, such as a price in US dollars passed in its place. `settledTokensMicro()` returns what a finished call settles at: its reported tokens at the price, never above its reservation, and the whole reservation when a count is missing or is not a whole number. In the example, the hour reserves 180,000 micro-dollars (0.18 US dollars), and the release settles the session at 37,700 for its 754 seconds, so the rest of the reservation leaves the day's total. `reserveSpend` throws a `RangeError` for an amount that is not a whole number of micro-dollars, zero or more, and for a start or an expiry that is not a valid date. It refuses every admission while the store returns a committed total that is not a whole number of micro-dollars, zero or more, since the day's spending is then not known, and it refuses an admission whose cap is not a whole number of micro-dollars, zero or more, such as `NaN` or infinity. A cost that is not a finite number, zero or more, settles the whole reservation in `releaseSpend`, as an expired one does, since the cost was never known; any other cost is rounded down to the micro-dollar.

`openAITranscriptionPricing(model)` returns the price per minute of audio, in US dollars, that [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) lists for five transcription models: `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `gpt-transcribe`, `gpt-realtime-whisper` and `gpt-live-transcribe`. For `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`, which OpenAI prices by token, it is the page's estimated cost of a minute. A dated snapshot without a row of its own takes its base model's, and any other model returns `undefined`. `openAIModelPricing(model)` returns the row, in US dollars per 1,000 tokens, that a budget estimates with. Both read only their tables' own rows, so a model named after a property every object inherits, such as `constructor`, has none. `OPENAI_MODEL_PRICING`, each of its rows and `OPENAI_TRANSCRIPTION_PRICING` are frozen, so a caller cannot change the prices that `OpenAIProvider` and the spend budgets use. Everything in this section is exported from `@framers/agentos` and from `@framers/agentos/safety/runtime`.

The [spend meter](./SAFETY_PRIMITIVES.md#spend-meter) is the other limit that outlives a process: an allowance of units per account and period, which the full runtime's `processRequest()` checks and `SqlSpendMeter` keeps on tables it can create itself.

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
