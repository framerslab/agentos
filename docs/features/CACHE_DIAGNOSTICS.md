# Cache Diagnostics

Anthropic prompt caching only pays off while the beginning of a request stays
byte-for-byte identical to a recent one. A reordered tool, a timestamp
interpolated into the system prompt, or an edited earlier message silently
invalidates the cache — and the only native signal is
`cache_read_input_tokens` dropping to zero, with no indication of what
changed.

AgentOS integrates Anthropic's cache-diagnostics beta
(`cache-diagnosis-2026-04-07`) to close that gap. When enabled, each request
carries the previous response's message id; the API compares the two requests
and returns a `cache_miss_reason` naming the first point of divergence — the
model, the system prompt, the tools, or the message history.

Diagnostics are observability only: they never block, alter, or fail a
request, and fingerprints stored by the API contain hashes and token-count
estimates, never prompt content.

## Agentic loops: one flag

For `generateText` (and every agent built on it), set `cacheDiagnostics:
true`. The loop threads each step's provider message id into the next step's
comparison automatically — step 1 opts in with `previousMessageId: null`,
step N references step N-1.

```ts
const result = await generateText({
  model: 'anthropic:claude-opus-4-8',
  prompt: 'Build the thing.',
  tools,
  maxSteps: 30,
  cacheDiagnostics: true,
  onAfterGeneration: async ({ step, cacheDiagnostics }) => {
    if (cacheDiagnostics?.cacheMissReason) {
      log.warn(
        { step, reason: cacheDiagnostics.cacheMissReason },
        'prompt cache missed — prefix diverged',
      );
    }
  },
});

// The last step's verdict also lands on the result:
result.cacheDiagnostics; // null = prefix stable | { cacheMissReason: {...} }
```

Per-step verdicts surface on the `onAfterGeneration` hook
(`GenerationHookResult.cacheDiagnostics`); the final result carries the last
step's verdict (`GenerateTextResult.cacheDiagnostics`).

## Single calls: thread the id yourself

At the provider layer, pass `cacheDiagnostics` in `ModelCompletionOptions`
and chain ids across calls:

```ts
const first = await provider.generateCompletion(model, messages, {
  cacheDiagnostics: { previousMessageId: null }, // opt in, nothing to compare
});

const second = await provider.generateCompletion(model, nextMessages, {
  cacheDiagnostics: { previousMessageId: first.id }, // compare against call 1
});

second.cacheDiagnostics;
// null                                → compared: no divergence
// { cacheMissReason: null }           → comparison still running (check next turn)
// { cacheMissReason: { type, ... } }  → earliest divergence identified
```

## Reading a verdict

`cacheMissReason.type` is the API's discriminant, passed through as an open
string so new types need no library update:

| type | Meaning | Fix |
| --- | --- | --- |
| `model_changed` | A router/fallback picked a different model; the cache is per-model. | Hold the model constant within a cached conversation. |
| `system_changed` | The system prompt differs — typically an interpolated timestamp or request id. | Keep the system prompt byte-stable; move dynamic data after the cache breakpoint. |
| `tools_changed` | Tools added, removed, reordered, or serialized non-deterministically. | Send the same tool list in a fixed order every turn. |
| `messages_changed` | An earlier history entry was altered rather than appended to. | Treat history as append-only; echo assistant turns and tool results back verbatim. |
| `previous_message_not_found` | No fingerprint for the referenced id (header missing on a prior turn, different workspace, or too much time passed). | Send the flag on every turn; keep turns close together. |
| `unavailable` | No comparison produced — another prompt-affecting parameter differs (`tool_choice`, `thinking`, beta set, …) or the divergence is beyond the comparison horizon. | Keep prompt-affecting request parameters constant for the conversation. |

The `*_changed` types also carry `cacheMissedInputTokens` — an estimate of how
many input tokens fell after the divergence point. Treat it as a magnitude
indicator, not a billing number.

Combine the verdict with usage: diagnostics answer "did my request change?",
`usage.cacheReadInputTokens` answers "did the cache hit?". A `null` verdict
with zero cache reads means the entry expired (TTL) rather than a request bug
— consider shorter gaps between turns or a 1-hour cache TTL on the
breakpoint.

## Notes and limits

- **Anthropic API only.** Other providers ignore the option; Bedrock/Vertex
  do not support the beta.
- **Send it every turn.** The comparison fingerprint is only stored for
  requests that carried the beta header — skipping a turn breaks the chain
  with `previous_message_not_found`.
- **Best-effort.** A missing verdict (`cacheMissReason: null`) means the
  comparison hadn't finished when the response serialized; check the next
  turn.
- The report names the **earliest** divergence only. Fix it first — later
  ones may be hidden behind it.
