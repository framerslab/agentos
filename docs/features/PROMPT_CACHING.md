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

result.usage.cacheReadTokens;     // tokens served from cache, summed over the call's steps
result.usage.cacheCreationTokens; // tokens written to cache this call
```

## GMI turns

A GMI labels each system entry `persona`, `conversation` or `turn`. An entry without a label is a `turn` entry. The GMI keeps priority order and splits off only the leading run of nonblank fixed entries (`persona` or `conversation`); a fixed entry after a turn entry stays where it is. Persona prompts and the GMI's own personality section are fixed; a learner's personality section holds for the conversation. Rolling summaries, prompt profiles, skill and discovery context, a structured reply's instruction, user preferences and contextual instructions are turn entries. The hard limits are fixed and close the system text.

| Target | Fixed prefix followed by turn entries | All entries fixed |
|---|---|---|
| Direct Anthropic, a Claude model with prompt caching | A fixed text part with a cache marker, then a plain system string | One marked text part |
| OpenRouter `anthropic/` | Two system strings; the provider marks the first and the message tail | One string; the provider marks it |
| Other providers | One joined system string | One joined system string |

The text and its order do not change: the system messages joined with a blank line are the single string sent without the split. The memory block goes in the newest user message, outside the cached system block, with the same token count and delivery record. History summaries and gateway schema instructions are later system messages.

No split or GMI marker is requested with `cache: false`, a `customModelParams` override of `system`, `messages`, `tools` or `cache_control`, `AGENTOS_ANTHROPIC_AUTO_CACHE=0` or `false`, or a model with no prompt-cache support. A nonempty `customModelParams.model` is the model that capability check reads. A fallback hop rebuilds the prompt for its own provider.

`cache: { ttl: '1h' }` gives the fixed marker a one-hour lifetime. `cache: { tail: false }` keeps only that marker; consider it when cognitive memory changes the newest user message every turn. Otherwise the provider's tail rule applies. A changed tool list, or a different discovered subset of tools, changes the cached prefix before the system text and can cause a miss.

`beforeModelCall` hooks must accept more than one system message and text parts. The GMI sends a hook's replacement messages as returned. If a hook keeps the GMI's marked part and the result holds more than four markers, the GMI removes only its own marker and records one warning. It adds no marker after the hook. `cache: false` keeps the single-string shape for hooks too.

On `agent({ runtime: 'gmi' })`, empty `systemBlocks` are dropped. Blocks through the last `cacheBreakpoint: true` form the fixed prefix; later blocks are turn entries. With no breakpoint, or none followed by a block, the joined text is one fixed entry. `onBeforeGeneration.system` is the joined base text, the recall instruction included when present.

The prompt engine's result reports the split in `metadata.systemSplit`: `fixedEntries`, `restEntries` and `marked`.

Limits:

- When `systemBlocks` has blocks after its last `cacheBreakpoint`, each block is its own system entry, and the prompt's token estimate rounds each entry up. The estimate can be up to one token higher for each extra block than for the joined text, so at a budget edge one more history message can be left out.
- Request-shape tests do not prove a cache hit. Model token floors, prefix changes and provider routing decide reuse. Whether OpenRouter keeps the split blocks upstream, and reuse there without a session ID, need live measurement. Nothing here measures OpenAI cache read-back or a cost saving.

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
  together. `cache: { tail: false }` leaves the tail out and sends your
  markers alone ([Per-call controls](#per-call-controls)).
- Caller **message** markers stand the auto path down entirely — if you are
  placing markers inside `messages`, you own placement.
- Marked **tool definitions** count toward Anthropic's 4-breakpoint request
  cap; the auto path drops its tail marker rather than exceed it. A
  top-level `cache_control` on an entry of `tools`, or on an `image_url`
  message part, is sent as set, TTL included.

Costs and floors (Anthropic pricing rules):

- Cache writes bill 1.25x (5-minute TTL) or 2x (1-hour TTL); reads bill
  0.1x. Break-even is 2 total requests within the TTL at 5m (one cache
  read), 3+ at 1h.
- Every model has a minimum cacheable prefix below which markers are
  **silently ignored** (no error, `cache_creation_input_tokens: 0`). The
  floors AgentOS applies
  ([`model-cache-capabilities.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/model-cache-capabilities.ts)):
  512 tokens on Fable 5 and 5.1, Mythos 5 and 5.1, Opus 5 and 5.5, Sonnet
  5.5 and Haiku 5.5; 1024 on Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5 and older
  Sonnets, Opus 4.0 and 4.1, and Opus 3; 2048 on Opus 4.7, Mythos Preview and
  Haiku 3.x; 4096 on Opus 4.5 and 4.6 and Haiku 4.5. Marking a sub-floor
  prefix is safe: it does nothing.
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

// Judges and classifiers: the same long rubric on every call, a new
// candidate each time. The rubric stays cached; no breakpoint goes on the
// candidate, which no later call would read back.
await generateText({
  model: 'anthropic:claude-haiku-4-5-20251001',
  system: [{ text: judgeRubric, cacheBreakpoint: true }],
  prompt: candidate,
  cache: { tail: false },
});

// True one-shots (nothing in the request is sent again): opt out so the call
// never pays a cache-write premium it cannot amortize.
await generateText({
  model: 'anthropic:claude-sonnet-4-6',
  system: oneOffInstructions,
  prompt: question,
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

- `cache?: { ttl?: '5m' | '1h'; tail?: boolean } | false` is accepted by
  `generateText`, `streamText`, `generateObject`, `agent({ cache })`, and
  per-hop fallback entries (`FallbackProviderEntry.cache`). `false` strips
  every marker from the request, including caller markers on messages and
  tool definitions and a request-level `cache_control` passed through
  `customModelParams`, directly and on OpenRouter `anthropic/*` slugs. A
  caller tool marker is read from the tools actually sent, so a
  `customModelParams.tools` override decides it. A per-call
  `'1h'` also raises caller system-marker TTLs so the request never orders
  a longer-lived breakpoint after a shorter one (Anthropic rejects that).
- `tail: false` puts no breakpoint on the messages and no request-level
  `cache_control` (Anthropic places that one on the last cacheable block,
  which is the tail). Your system, message and tool markers go out exactly
  as you set them, TTLs included, since no tail follows them. With no
  marker of yours anywhere, the end of the first system message is marked
  (with `ttl` when given); a `customModelParams.system` override stands in
  for that message, and its last text block is marked on a copy. A request
  with no system goes out unmarked. On
  OpenRouter `anthropic/*` slugs a request that carries a marker of yours
  (on a message, a tool definition or the request root, a
  `customModelParams.cache_control` included) goes out as you sent it, as
  it does by default; one with none gets a
  marker on the first system message and none on the final message; a
  `customModelParams.messages` override stands in for the messages, and
  its first system message is marked on a copy. The
  default tail is right for conversations and agent loops, where it is
  what reads the history back; leave it out where the prefix repeats and
  the tail never does. `false` would drop the prefix
  marker too, so the rubric would be billed at the full input price on
  every call.
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
- `serviceTier`: emitted verbatim as `service_tier`. `streamText()`,
  `generateObject()` and `streamObject()` take it too; `generateObject()`
  sends it on every attempt, a validation retry included.

## Usage normalization and telemetry

Every provider reports cache activity in the same fields of its
`ModelUsage`, and `generateText()` / `streamText()` sum them over a call's
steps into the result's `usage`; `generateObject()` sums its attempts the same
way, a validation retry included:

| Provider response (`ModelUsage`) | Result (`usage`) | Meaning |
|---|---|---|
| `cacheReadInputTokens` | `cacheReadTokens` | Prompt tokens served from cache |
| `cacheCreationInputTokens` | `cacheCreationTokens` | Prompt tokens written to cache |
| `cacheCreationExtendedInputTokens` | `cacheCreationExtendedTokens` | Of the writes, those made with the longer lifetime: Anthropic's 1 hour (`cache_creation.ephemeral_1h_input_tokens`), OpenAI's 12 hours (`cache_write_tokens_details.ttl_12h_tokens`). Absent when the response does not split its writes by lifetime |
| `inclusiveInputTokens` | `inclusiveInputTokens` | All input tokens, cached ones included |

`promptTokens` follows the provider: Anthropic's excludes the cached tokens,
while OpenAI's and OpenRouter's include them. Use `inclusiveInputTokens` for a
total that means the same on every provider. On Anthropic it is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, so a
cached call priced from `promptTokens` is priced on its uncached tail alone.

Sources: Anthropic `usage.cache_read_input_tokens` /
`cache_creation_input_tokens`; OpenAI and OpenAI-compatible
`prompt_tokens_details.cached_tokens`, plus `cache_write_tokens` where
reported (GPT-5.6+ families) and the Responses API's
`input_tokens_details` with its `cache_write_tokens_details` split; OpenRouter unified usage; Gemini
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
