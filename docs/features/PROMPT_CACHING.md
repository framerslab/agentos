# Prompt Caching

AgentOS caches LLM prompt prefixes by default on every provider that supports
it. A multi-turn agent, chat loop, or pipeline gets the provider's discounted
cache pricing with zero configuration; per-call options tune the TTL, opt
one-shots out, or shard cache routing. Cache activity is normalized into the
same usage fields on every provider, so cost metering reads one shape
everywhere; leak detection additionally samples the Anthropic paths.

```ts
import { generateText } from '@framers/agentos';

// Zero config: the system prefix and the conversation history are cached
// automatically. Turn 2+ reads the prefix back at the provider's cache-read
// rate instead of re-billing it at full price.
const result = await generateText({
  model: 'anthropic:claude-sonnet-4-6',
  system: worldRules,
  messages: history,
  prompt: playerAction,
});

result.usage.cacheReadInputTokens;     // tokens served from cache
result.usage.cacheCreationInputTokens; // tokens written to cache this call
```

## What zero config does, per provider

| Provider | Cache mechanism | Default behavior |
|---|---|---|
| Anthropic (direct) | Explicit `cache_control` breakpoints | Markers placed automatically on the system prompt and the moving message tail; multi-turn history is read back on turn 2+. Works for `generateText`, `streamText`, `generateObject`, and every agent built on them. |
| Anthropic via OpenRouter (`anthropic/*` slugs) | `cache_control`, forwarded unchanged by OpenRouter | The same two markers are injected into the wire payload automatically. Pass `sessionId` so OpenRouter's sticky routing re-uses the upstream host that holds the cache. |
| OpenAI (native endpoint) | Automatic server-side prefix caching (1024+ tokens) | Cache hits are normalized from `prompt_tokens_details.cached_tokens` (Chat Completions and Responses API). When a call carries `sessionId`, a hashed `prompt_cache_key` is derived and sent so cache routing stays on the shard that holds the prefix. |
| OpenAI-compatible gateways (Groq, xAI, Together, Mistral) | Gateway-side automatic caching where offered | Cached tokens are normalized when reported. No extra request fields are sent — some gateways reject unknown params, so the `prompt_cache_key` default stays off outside api.openai.com. |
| Gemini | Implicit caching, default-on for 2.5+ models | `usageMetadata.cachedContentTokenCount` is normalized into `cacheReadInputTokens`. |
| OpenRouter (non-Anthropic slugs) | Upstream automatic caching | `cached_tokens` and cost are normalized from OpenRouter's unified usage accounting; `sessionId` pins provider sticky routing so host-scoped upstream caches actually get re-read. |

Prefix stability is the universal requirement: OpenAI and Gemini caching is
automatic but prefix-keyed, so the same discipline that makes Anthropic
breakpoints hit (static content first, volatile content last) pays on every
provider at once.

## Anthropic mechanics

Anthropic caching is an exact byte-prefix match over the request in render
order `tools → system → messages`, activated only by explicit
`cache_control` markers. The auto path in `AnthropicProvider` places up to
two: one covering the system prompt, one on the moving message tail so the
grown history is read back next turn. Caller markers compose with it:

- Caller **system** markers (via `SystemContentBlock.cacheBreakpoint`) keep
  the auto tail marker — your custom prefix split and history caching work
  together.
- Caller **message** markers stand the auto path down entirely — if you are
  placing markers inside `messages`, you own placement.
- Marked **tool definitions** count toward Anthropic's 4-breakpoint request
  cap; the auto path drops its tail marker rather than exceed it.

Costs and floors (Anthropic pricing rules):

- Cache writes bill 1.25x (5-minute TTL) or 2x (1-hour TTL); reads bill
  0.1x. Break-even is 2 total requests within the TTL at 5m (one cache
  read), 3+ at 1h.
- Every model has a minimum cacheable prefix below which markers are
  **silently ignored** (no error, `cache_creation_input_tokens: 0`): 4096
  tokens on Opus 4.5–4.8 and Haiku 4.5; 2048 on Fable/Mythos 5, Opus 5,
  Sonnet 4.6, Sonnet 5, and Haiku 3.x; 1024 on Sonnet 3.7–4.5. (Opus 5's
  documented floor is 512; agentos's floor heuristics hold the conservative
  2048.) Marking a sub-floor prefix is safe — it just does nothing.
- Caches are model-scoped: a fallback or retry on a different model is a
  cold start. AgentOS's canonical fallback chains pin `cache: false` on
  every leg for exactly this reason — failover hops are one-shots that
  would pay the write premium and never read it back.

## Per-call controls

```ts
// Slow loops (agent steps gapped minutes apart, human think-time): give the
// auto markers and the moving tail a 1-hour TTL.
await generateText({
  model: 'anthropic:claude-opus-4-8',
  system: orchestratorRules,
  messages: transcript,
  tools,
  maxSteps: 30,
  cache: { ttl: '1h' },
  sessionId: jobId,
});

// One-shots (judges, classifiers, single-question calls): opt out so the
// call never pays a cache-write premium it cannot amortize.
await generateText({
  model: 'anthropic:claude-sonnet-4-6',
  system: judgeRubric,
  prompt: candidate,
  cache: false,
});

// Custom prefix split: mark the stable block yourself, keep volatile bytes
// after the last breakpoint. The auto tail marker still caches history.
await streamText({
  model: 'anthropic:claude-sonnet-4-6',
  system: [
    { text: stableRules, cacheBreakpoint: true, cacheTtl: '1h' },
    { text: perTurnState }, // unmarked, after the breakpoint
  ],
  messages: history,
});
```

- `cache?: { ttl?: '5m' | '1h' } | false` is accepted by `generateText`,
  `streamText`, `generateObject`, agent configs (`AgentConfig.cache`), and
  per-hop fallback entries (`FallbackProviderEntry.cache`). `false` strips
  every marker from the request, including caller markers. A per-call
  `'1h'` also raises caller system-marker TTLs so the request never orders
  a longer-lived breakpoint after a shorter one (Anthropic rejects that).
- `generateObject` additionally takes `schemaCacheTtl` for its
  schema-instruction block.
- `sessionId` is the cross-provider affinity key: OpenRouter forwards it as
  `session_id` for sticky routing; OpenAI derives `prompt_cache_key` from
  it. Pass a stable id per conversation (game session id, companion
  conversation id, job id).
- `AGENTOS_ANTHROPIC_AUTO_CACHE=0` kills the auto path process-wide (direct
  Anthropic and OpenRouter `anthropic/*` injection both honor it); caller
  markers still pass through. Use it for burst harnesses that can never
  amortize a write.

## OpenAI typed cache options

```ts
await generateText({
  model: 'openai:gpt-5.5',
  system: rules,
  prompt: input,
  sessionId: conversationId,     // prompt_cache_key derives from this
  promptCacheRetention: '24h',   // extended retention where supported
  serviceTier: 'priority',
});
```

- `promptCacheKey`: `'auto'` (derive `agentos:<first 16 hex of
  sha256(sessionId)>`; the raw id never leaves the process), an explicit
  string (sent verbatim), or `false` (omit). Absent defaults to `'auto'` on
  the native OpenAI endpoint unless the call carries `cache: false`;
  OpenAI-compatible gateways keep the omit default. OpenAI recommends
  ≤~15 requests/min per key.
- `promptCacheSessionId`: derivation source for `'auto'` when the affinity
  `sessionId` is absent; never sent on the wire.
- `promptCacheRetention`: `'30m'` (GPT-5.6+ via `prompt_cache_options.ttl`),
  `'24h'` or `'in_memory'` (`prompt_cache_retention`, enumerated allow-list).
  Unsupported model/value combinations are omitted with a debug log — never
  a hard error.
- `serviceTier`: emitted verbatim as `service_tier`.

## Usage normalization and telemetry

Every provider reports cache activity in the same two `ModelUsage` fields,
with `promptTokens` always inclusive of the cached subset:

| Field | Meaning |
|---|---|
| `cacheReadInputTokens` | Prompt tokens served from cache this call |
| `cacheCreationInputTokens` | Prompt tokens written to cache this call |

Sources: Anthropic `usage.cache_read_input_tokens` /
`cache_creation_input_tokens`; OpenAI and OpenAI-compatible
`prompt_tokens_details.cached_tokens`, plus `cache_write_tokens` where
reported (GPT-5.6+ families) and the Responses API's
`input_tokens_details`; OpenRouter unified usage; Gemini
`usageMetadata.cachedContentTokenCount`. An explicit zero is preserved (an
observed miss); the fields are absent when a provider reports nothing.

On top of the per-call fields:

- The cache-leak detector samples Anthropic requests (streaming and
  non-streaming) and warns when marked requests neither create nor read
  cache (the floor-miss signature) and on sustained zero-read streaks
  (prefix churn).
- `LlmUsageEvent` stamps `fallbackDepth`, so a leg served by a failover hop
  (always `cache: false`) is distinguishable from a primary-path miss.
- For turn-by-turn miss attribution, enable
  [Cache Diagnostics](CACHE_DIAGNOSTICS.md) — the API names the first point
  of divergence (model, system, tools, or history) per request.

## What still needs caller discipline

Zero config cannot make an unstable prompt cacheable. The rules that keep
prefixes byte-stable:

- **Static first, volatile last.** Timestamps, counters, per-turn state,
  and freshly generated content belong after the last breakpoint (or in the
  final user message), never inside the stable prefix.
- **Evict history in chunks, not per turn.** A window that slides by one
  message every turn rewrites the message region every turn; dropping a
  block of N messages once past a threshold keeps the region stable between
  evictions.
- **Keep tool definitions and their order stable.** Tools render first; any
  change invalidates everything after them.
- **Parallel identical prefixes don't share** on Anthropic until the first
  response starts streaming; serialize the first request of a burst when
  the prefix is shared. (Other providers don't document their concurrent
  cache-fill behavior — the serialization habit is safe everywhere.)
