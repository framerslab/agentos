# API Reference

Everything is one import. Pick the function that fits your task:

```typescript
import {
  generateText, streamText,        // Text generation
  generateObject, streamObject,    // Structured output (Zod validated)
  generateImage, transferStyle,    // Image generation & style transfer
  removeBackground,                // Subject cut-out on a transparent PNG
  generateVideo, analyzeVideo,     // Video generation & analysis
  generateMusic, generateSFX,      // Audio generation
  performOCR,                      // Vision / OCR
  embedText,                       // Embeddings
  agent,                           // Multi-turn agent sessions
  agency,                          // Multi-agent teams
  probeProviderKey,                // Whether one API key works
} from '@framers/agentos';
```

## Quick Reference

| Function | What it does | Example |
|----------|-------------|---------|
| `generateText()` | One-shot text generation | `await generateText({ provider: 'openai', prompt: '...' })` |
| `streamText()` | Stream text in real-time | `for await (const d of streamText({...}).textStream) {}` |
| `generateObject()` | Extract structured JSON (Zod) | `await generateObject({ schema: z.object({...}), prompt: '...' })` |
| `generateImage()` | Generate images (with character consistency) | `await generateImage({ provider: 'openai', prompt: '...' })` |
| `transferStyle()` | Restyle an image after a reference image, sending the provider both | `await transferStyle({ image: src, styleReference: ref, prompt: '...' })` |
| `removeBackground()` | Cut the subject out of an image onto a transparent PNG (fal BiRefNet) | `await removeBackground({ image: 'https://example.com/hero.png' })` |
| `generateVideo()` | Generate video from text/image | `await generateVideo({ prompt: '...' })` |
| `generateMusic()` | Generate music | `await generateMusic({ prompt: '...' })` |
| `performOCR()` | Extract text from images | `await performOCR({ imagePath: './doc.png' })` |
| `embedText()` | Generate embeddings | `await embedText({ input: ['hello'] })` |
| `agent()` | Multi-turn sessions with history, tools and hooks | `const a = agent({ provider: 'openai' })` |
| `gmi()` | `agent({ runtime: 'gmi' })`: sessions served by GMIs, with cognitive memory, sentiment tracking and metaprompts per profile | `const a = gmi({ provider: 'openai', cognition: 'full' })` |
| `souledAgent()` | Soul-file agent with the operator's `memory/` wiki and memory kept per user | `await souledAgent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' })` |
| `agency()` | Multi-agent teams | `const team = agency({ agents: {...}, strategy: 'parallel' })` |
| `probeProviderKey()` | Whether one API key is live, out of credit, rejected or throttled, by its provider's billing probe | `await probeProviderKey({ provider: 'anthropic', apiKey })` |

All functions accept `provider` as a top-level key.

## Provider Resolution

### Calling Styles

Two styles for specifying provider and model:

```ts
// 1. Provider-first — AgentOS picks the best default model for the task
await generateText({ provider: 'openai', prompt: '...' });

// 2. Provider + explicit model — full control
await generateText({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', prompt: '...' });
```

### Provider Defaults

When you supply `provider` without an explicit `model`, AgentOS resolves the default model
for the requested task automatically:

| Provider                 | Type  | Text default               | Image default                    | Embedding default        | Env var                           |
| ------------------------ | ----- | -------------------------- | -------------------------------- | ------------------------ | --------------------------------- |
| `openai`                 | Cloud | `gpt-4o`                   | `gpt-image-2.5-flare`            | `text-embedding-3-small` | `OPENAI_API_KEY`                  |
| `anthropic`              | Cloud | `claude-sonnet-4-6`        | —                                | —                        | `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL` for another endpoint) |
| `gemini`                 | Cloud | `gemini-2.5-flash`         | —                                | —                        | `GEMINI_API_KEY`                  |
| `openrouter`             | Cloud | `openai/gpt-4o-mini`       | —                                | —                        | `OPENROUTER_API_KEY`              |
| `claude-code-cli`        | Local | `claude-sonnet-4-6`        | —                                | —                        | `which claude`                    |
| `gemini-cli`             | Local | `gemini-3.5-flash`         | —                                | —                        | `which gemini`                    |
| `stability`              | Cloud | —                          | `stable-diffusion-xl-1024-v1-0`  | —                        | `STABILITY_API_KEY`               |
| `replicate`              | Cloud | —                          | `black-forest-labs/flux-1.1-pro` | —                        | `REPLICATE_API_TOKEN`             |
| `groq`                   | Cloud | `llama-3.3-70b-versatile`  | —                                | —                        | `GROQ_API_KEY`                    |
| `together`               | Cloud | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | —                 | —                        | `TOGETHER_API_KEY`                |
| `mistral`                | Cloud | `mistral-large-latest`     | —                                | —                        | `MISTRAL_API_KEY`                 |
| `xai`                    | Cloud | `grok-2`                   | —                                | —                        | `XAI_API_KEY`                     |
| `requesty`               | Cloud | `openai/gpt-4o`            | —                                | —                        | `REQUESTY_API_KEY`                |
| `bfl`                    | Cloud | —                          | `flux-pro-1.1`                   | —                        | `BFL_API_KEY`                     |
| `fal`                    | Cloud | —                          | `fal-ai/flux/dev`                | —                        | `FAL_API_KEY`                     |
| `minimax`                | Cloud | `MiniMax-M3.1-Flash`        | `image-01`                       | —                        | `MINIMAX_API_KEY`                 |
| `ollama`                 | Local | `llama3.2`                 | —                                | `nomic-embed-text`       | `OLLAMA_BASE_URL`                 |
| `stable-diffusion-local` | Local | —                          | `v1-5-pruned-emaonly`            | —                        | `STABLE_DIFFUSION_LOCAL_BASE_URL` |

When neither `provider` nor `model` is given, AgentOS checks configured runtimes in order
(`OPENROUTER_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `GEMINI_API_KEY` → `GROQ_API_KEY` → `TOGETHER_API_KEY` → `MISTRAL_API_KEY` → `XAI_API_KEY` → `REQUESTY_API_KEY` → `MINIMAX_API_KEY` → `which claude` → `which gemini` → `OLLAMA_BASE_URL`). An empty or whitespace-only `OLLAMA_BASE_URL` or `STABLE_DIFFUSION_LOCAL_BASE_URL` is unset, as the call reads it, so detection goes on to the next runtime. Or call `setDefaultProvider({ provider, apiKey })` once at boot to skip env vars entirely; every subsequent function inherits that default while still letting inline `apiKey` win when supplied.

MiniMax text requests default to `MiniMax-M3.1-Flash`; the current catalog also includes
`MiniMax-M3`. Both accept image input and tools. Explicit model IDs, including saved
legacy or custom IDs, remain unchanged. Set `MINIMAX_API_KEY` and optionally
`MINIMAX_BASE_URL` (`https://api.minimax.io/v1` by default, or `https://api.minimax.cn/v1` for
China, the root [MiniMax's China documentation](https://platform.minimax.cn/docs/api-reference/text-openai-api)
names; the older China root `https://api.minimaxi.com/v1` is accepted too). For example:

```ts
await generateText({ provider: 'minimax', prompt: 'Explain this briefly.', effort: 'high' });
await generateText({ model: 'minimax:MiniMax-M3', prompt: 'Explain this briefly.' });
```

Flash always uses adaptive thinking. Its allowed `effort` values are `low`, `medium`,
`high`, `xhigh`, and `max`; omitting effort leaves the server default in place.
`thinking: false`, `service_tier`, and `reasoning_split: false` are rejected for Flash.
Tool continuations preserve separate reasoning content, and image URL/data-URL parts
are forwarded through the Chat Completions API. See the
[MiniMax OpenAI API reference](https://platform.minimax.io/docs/api-reference/text-openai-api).
MiniMax image generation uses `image-01`, also when `setDefaultProvider()` names a MiniMax text
model such as `MiniMax-M3.1-Flash`: on the global root and on either China root, an image call drops
the chat model the default names and takes the provider's image model. A root counts as one in any
letter case of its scheme and host, as fetch lowercases them. An empty or whitespace-only `baseUrl`
on the call or the default is unset, so `MINIMAX_BASE_URL` applies as it does for a call with no
`baseUrl`: a MiniMax root there takes `image-01`, a custom endpoint there keeps the default's model,
and with no variable the call goes to the global root and takes `image-01` there too. MiniMax publishes no
embedding model, so the `minimax` provider and `embedText()` refuse an embedding request before
sending it; embed with another provider.

`embedText()` embeds on `openai`, `openrouter`, `mistral`, `requesty`, `gemini` and `ollama`, each at its own endpoint or at the `baseUrl` you set, and sends a key to no other host. It refuses a provider with no embeddings (`anthropic`, `groq`, `together`, `xai`, `minimax`, the image providers and the CLIs) before reading its key, and needs `baseUrl` for a provider id agentos does not know ([embedText()](../orchestration/STRUCTURED_OUTPUT_API.md#embedtext)).

### Inline API Keys

Every function accepts `apiKey` and `baseUrl` as top-level parameters, overriding the corresponding environment variable for that call:

```ts
// Pass apiKey directly — useful for multi-tenant apps, tests, or dynamic config
await generateText({
  provider: 'openai',
  apiKey: 'sk-my-specific-key',     // overrides OPENAI_API_KEY
  prompt: 'Hello world',
});

// Works on agent() and agency() too
const bot = agent({
  provider: 'anthropic',
  apiKey: process.env.CUSTOMER_KEY,  // per-customer key
  instructions: 'You are a helpful assistant.',
});
```

A `baseUrl` is read with surrounding whitespace removed, and one that is an empty or whitespace-only string is unset: the call reads the global default's URL, then the provider's base-URL variable, as it does with no `baseUrl`, and with none it goes to the provider's own endpoint. The same reading applies to the default's `baseUrl` and to the variable (`OPENAI_BASE_URL=` leaves OpenAI's own endpoint), so no request is built on a blank base, whose relative URL (`/chat/completions`) Node's fetch rejects and a browser's would resolve against the page's own origin, with the key. A blank `baseUrl` names no endpoint, so it is not refused where a base URL meant for one provider would be: beside a `model` whose `provider:` prefix names another provider than `provider`, and on an image call that names no provider, the call runs as it does with no `baseUrl`. A key there is still refused.

### Local Providers

Local providers don't require API keys — just a `baseUrl` (or the corresponding env var):

```ts
// Ollama — runs any GGUF model locally
await generateText({
  provider: 'ollama',
  model: 'llama3.2',
  prompt: 'Explain quantum entanglement simply.',
  baseUrl: 'http://localhost:11434', // or set OLLAMA_BASE_URL
});

// Anthropic fallback: if ANTHROPIC_API_KEY is unset but OPENROUTER_API_KEY is set,
// AgentOS automatically routes anthropic requests through OpenRouter.
```

## `generateText()`

```ts
import { generateText } from '@framers/agentos';

// Provider-first: AgentOS picks the default model for the provider.
const { text, usage } = await generateText({
  provider: 'openai',
  prompt: 'Summarize the TCP three-way handshake in 3 bullets.',
});

console.log(text);
console.log(usage.totalTokens);
```

`generateText({ tools })` and `streamText({ tools })` accept three forms:

- A named high-level tool map
- An [`ExternalToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/externalToolRegistry.ts) (`Record`, `Map`, or iterable)
- A prompt-only `ToolDefinitionForLLM[]`

External registries are exposed to the model and executed when called.
Prompt-only `ToolDefinitionForLLM[]` are exposed to the model too, but if the
model calls one without an executor attached, AgentOS returns an explicit tool
error instead of silently no-oping.

In the native tool loop of either call, the model's next step receives a tool's
output as JSON. A tool that succeeds with no output, or with one JSON leaves out
(a function, a symbol, a `toJSON` that returns nothing), is sent as the empty
string's JSON (`""`) and recorded as a success. A tool whose output cannot be
written as JSON (a getter or a `toJSON` that throws, a cycle) fails with the
error the write threw, in the native loops and the prompt-tool loop alike, and
an agency seat's mask does not change that.

The same `tools` forms work on `agent({ tools })` and `agency({ tools })`.
When an agency-level tool set is combined with per-agent tools, AgentOS
normalizes both sides first and then merges by tool name, with the per-agent
tool winning on collisions.

Persist helper usage for later inspection:

```ts
import { generateText, getRecordedAgentOSUsage } from '@framers/agentos';

await generateText({
  provider: 'openai',
  prompt: 'Summarize QUIC in one sentence.',
  usageLedger: {
    enabled: true,
    sessionId: 'demo-session',
  },
});

const totals = await getRecordedAgentOSUsage({ enabled: true, sessionId: 'demo-session' });
console.log(totals.totalTokens);
```

### OpenAI response storage

```ts
import { generateObject, generateText } from '@framers/agentos';

await generateText({ provider: 'openai', prompt: 'Summarize this call.', store: false });
await generateObject({ provider: 'openai', schema, prompt: transcript, store: false });
```

`store` is sent to OpenAI as `store` on the request body, on `/v1/chat/completions` and `/v1/responses` alike. OpenAI's [migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) says "Responses are stored by default. Chat completions are stored by default for new accounts. To disable storage when using either API, set `store: false`." `streamText()` takes it too. Every request the call makes carries the option, which covers each step of the tool loop, the planning request, each attempt of `generateObject()` and a fallback leg to OpenAI. Left out, a chat completion sends no `store` key and a Responses request sends `store: false`. The providers built on the OpenAI provider (Groq, xAI, Together, Mistral, LiteLLM, MiniMax) send it to their own endpoint too; the other providers ignore it. `ModelCompletionOptions.store` sets it on a direct `generateCompletion()` call.

### Guards on a call

```ts
import { GuardrailStopError, generateText } from '@framers/agentos';

const guards = {
  services: [hardBan, classifier],
  context: { userId: user.id, sessionId: thread.id, moderation: { surface: 'agent_turn' } },
};

try {
  const { text, guardReport } = await generateText({ provider: 'openai', prompt, tools, guards });
  show(text);
} catch (error) {
  if (!(error instanceof GuardrailStopError)) throw error;
  if (error.code === 'GUARDRAIL_UNAVAILABLE') askToRetry();
  else if (error.code === 'GUARDRAIL_HELD') queueForReview(error.hold?.reviewCode);
  else refuse(error.reasonCode);
}
```

`guards` enforces a host's guards on the call itself:

| Field | Meaning |
|---|---|
| `services` | The guards, in registration order. Each runs as `moderateContent()` runs it: closed unless its config says `failClosed: false`, with a deadline |
| `context` | The `GuardrailContext` every guard receives. `context.moderation` is checked as `moderateContent()` checks it |
| `mode` | `enforce` (default) applies every verdict. `dryRun` runs every guard, reports each verdict with `enforced: false` and changes nothing |
| `stages` | Any of `input`, `toolCalls` and `output`. Default: every stage some guard implements |
| `output` | `streamText()` only: `hold` (default) or `stream` (see [Guards on a stream](#guards-on-a-stream)) |
| `timeoutMs` | The deadline of a guard whose config sets none. Default 8000 |
| `onVerdict` | Called with each stage decision other than an allow, enforced or not. A callback that throws writes `guardrail.verdict_callback_failed`, and the verdict stands |

A `mode` other than `enforce` or `dryRun`, a `services` that is not an array or a `context.moderation` that fails its check is a `TypeError` before any guard runs: `generateText()` rejects with it and `streamText()` yields it as an `error` part.

The guards run in three stages:

- **Input, once, before the first provider request.** The call's own user turn is judged: `prompt`, else the last message when its role is `user`. A call whose messages end on another role has no input stage. The guards with `evaluateInput` read the turn's text and its images (a `data:` URL as its bytes, any other URL as a URL). A `BLOCK` stops the call before any request is made. A `BLOCK` whose evaluation carries a non-empty `replacementText` is the reply instead: no request is made, `text` is that text, `usage` is zero and `transcriptDelta` is empty. A rewrite sends the rewritten text in the turn's place; in multi-part content one text part takes the place of the text parts and the images stay. A text a guard removed (`modifiedText: null`) is sent as an empty turn, never as the original.
- **Tool calls, each one, in every tool loop.** The guards with `evaluateOutput` and `config.evaluateToolCalls: true` judge each call the model makes, in the native tool loop and the prompt-tool loop of every leg, on the arguments the model sent, before `onBeforeToolExecution` and before any approval gate. A refused call does not run and no hook sees it: the model reads `This tool call was refused by a guardrail.` as its result, with the guard's `reasonCode` when it gave one, and the loop goes on. In `streamText()` a call's `tool-call` part goes out after the guards passed it; a refused call shows as its `tool-result` part alone. A caller's `abortSignal` that fires while the guards are judging ends the call before any hook or tool runs. A hold refuses the call too. A refused tool call is not a stop.
- **Output, the whole reply, before the caller receives it.** A `BLOCK` stops the call. A `BLOCK` that carries a `replacementText` puts that text in the reply's place, and a rewrite replaces the reply, a rewrite of the reply's streamed pieces by a guard with `evaluateStreamingChunks` included. An empty reply is not judged. A caller's `abortSignal` that fires while the guards judge the prompt or the reply rejects `generateText()` with the signal's reason; `streamText()` ends with an `error` part that carries it, before any held text goes out.

What decides a stage is what decides `moderateContent()`: a rule's `BLOCK`, else a hold, else a closed guard's failure, else a `FLAG`. A screen with `sequential: true` answers first, as it does there.

A stop rejects with `GuardrailStopError`:

| Field | Meaning |
|---|---|
| `code` | `GUARDRAIL_BLOCKED` (a rule), `GUARDRAIL_HELD` (held for a person's review; `hold` is set) or `GUARDRAIL_UNAVAILABLE` (nothing but a closed guard that threw, ran late or answered no recognised action decided it) |
| `stage` | `input`: no request was made. `output`: the reply was withheld |
| `reasonCode`, `guardrailId`, `hold` | The deciding evaluation's |
| `report` | The call's report, below |
| `usage` | What the call had spent, on the output stage |

Its message is one fixed sentence: it holds no guard's reason, no prompt and no reply. The input and output stages run once per call, outside the fallback chain, so a stop is not retried on a fallback provider and does not count against a provider's health.

`result.guardReport`, and `error.report` after a stop:

| Field | Meaning |
|---|---|
| `mode` | `enforce` or `dryRun` |
| `input`, `output` | Each stage's evaluations, as `toModerationEvaluation()` reports them. After a block, `output` holds what every guard that ran answered, the guards before the one that blocked included |
| `toolCalls` | `{ toolCallId, toolName, evaluations }` for each judged call. `toolCallId` is the call's own number, `tc_<step>_<index>` (the step from 1, the index from 0 in the order the model listed the step's calls), never the provider's or the model's id. `toolName` is the registered tool's name, or `unregistered` when the model named no tool of the call's list |
| `result` | `passed`, `sanitized` (a guard rewrote the input or the reply), `replaced` (a fixed reply took its place) or `stopped` |

The report carries codes, ids and scores: no guard's `reason`, no prompt, no reply and no call id from a provider. An evaluation's `metadata` is the guard's own and passes through as the guard wrote it, as in `moderateContent()`.

After a reply was rewritten or replaced, `text` is what the caller receives and the last assistant entry of `transcriptDelta` holds that text, so a next turn built from the delta never sends what a guard took out. When the reply ended the call, that entry is the delta's last, `{ role: 'assistant', content: <that text> }`. When `maxSteps` ended the call on a tool step, the reply is that step's text: its assistant entry keeps its tool calls and holds the delivered text, and the step's tool results follow it. After the input was rewritten, the delta's user turn is the rewritten one, as it was sent.

`onVerdict` receives one verdict per stage decision: `stage` (`input`, `toolCall` or `output`), `action`, `enforced`, `unavailable`, `guardrailId`, `reasonCode`, `hold`, and on a tool call `toolCallId` and `toolName`. On the output stage `originalText` and `finalText` hold the reply as the guards judged it and as the caller receives it, so a host keeps them out of its logs. Each verdict also writes one `guardrail.verdict` line ([Logging](../observability/LOGGING.md#guardrail-events)).

With `mode: 'dryRun'` every guard runs as it does in enforcement and every verdict reaches `onVerdict` with `enforced: false`; the input is sent as given, tools run and the reply is returned as the model wrote it.

## `streamText()`

```ts
import { streamText } from '@framers/agentos';

const result = streamText({
  provider: 'openai',
  prompt: 'Stream a short explanation of how TLS differs from TCP.',
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}

console.log(await result.text);
```

### Guards on a stream

`streamText()` takes the same `guards` as [`generateText()`](#guards-on-a-call), and `result.guardReport` resolves to the report when the stream ends.

- **`output: 'hold'`** (the default). No text part is delivered before the output guards have judged the whole reply; tool calls and the other parts pass as they come. A stop yields no text part and one `error` part carrying the `GuardrailStopError`; `await result.text` is the empty string and `finishReason` is `error`.
- **`output: 'stream'`.** Text flows as it arrives, and only a guard with `evaluateStreamingChunks` can stop it mid-stream. The final guards still judge the whole reply: a `BLOCK` arrives as an `error` part after the text, one that carries a `replacementText` included, since the text is already out and nothing can take its place. A rewrite is reported with `enforced: false` and not applied.

`text` resolves with what was delivered and nothing else when a guard stopped, replaced or rewrote the reply; when they passed it, `text` resolves as it does for the same call without guards (the last step's text). An input stop ends the stream the same way, before any request. The `error` part is in `fullStream`: a caller that reads `textStream` alone sees the text stop and no error, so it also reads `finishReason` or `guardReport`. In a dry run the reply streams as it arrives, the output guards judge it whole once it was delivered, and `text` resolves as it does for the same call without guards (the last step's text).

## Cancellation

```ts
import { generateObject } from '@framers/agentos';
import { z } from 'zod';

try {
  const { object } = await generateObject({
    provider: 'openai',
    schema: z.object({ planet: z.string() }),
    prompt: 'Which planet in the solar system is the largest?',
    // Give up after eight seconds: the request is cancelled, and no retry or fallback runs.
    abortSignal: AbortSignal.timeout(8000),
  });
  console.log(object.planet);
} catch (error) {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    console.log('No answer within eight seconds.');
  } else {
    throw error;
  }
}
```

`generateText()`, `streamText()`, `generateObject()`, `streamObject()` and `embedText()` take an `abortSignal`, and so do an agent session's `send(input, { abortSignal })` and `stream(input, { abortSignal })`. When the signal aborts:

- The provider request in flight is cancelled. A non-streamed request to OpenAI, Anthropic, Gemini, OpenRouter, Requesty or Ollama is aborted at once, whether it waits for its answer or its headers, and so is a stream on any of them, a body read that has stalled included; the stream ends with its abort chunk. The OpenAI, OpenRouter, Requesty, Ollama and Gemini providers' `generateEmbeddings()` abort their request as well (on OpenRouter and Requesty the model-list read made first for a model not yet listed too, and an already-aborted call sends nothing), and `embedText()` aborts its request to the embeddings endpoint, Ollama or Gemini. Aborting ends the caller's wait, not always the vendor's work: OpenRouter stops processing and billing only for a stream on the providers it lists, and keeps processing and bills a non-streamed request in full ([OpenRouter: stream cancellation](https://openrouter.ai/docs/api-reference/streaming)). A provider that does not read the signal runs its request to the end, and the call still ends as below.
- A provider waiting between retries stops waiting at once: the OpenAI, Anthropic, Gemini and OpenRouter providers end a 429's Retry-After (up to an hour) or the backoff after a 5xx, Anthropic's 529 or a network failure the moment the signal aborts, and send no further request.
- No further step, retry or fallback hop starts, and `generateObject()` starts no further attempt. A tool round that `generateText()` or `streamText()` has started runs to its end first; the call then ends as below rather than returning that round as its result. The call is not counted against the provider's health.
- The call rejects with the signal's reason: a `DOMException` named `AbortError` after `controller.abort()`, one named `TimeoutError` from `AbortSignal.timeout()`, or the value given to `controller.abort(reason)`. `streamText()` and a session's `stream()` end with an `error` part that carries the reason (in an `Error` when the reason is not one), and `streamObject()`'s `object` rejects with the reason.
- A call whose signal has already aborted sends no request.

A session stays open after an aborted `send()` or `stream()`, and its next call runs as usual. Without `runtime: 'gmi'`, the aborted turn is added to no history. With it, the signal is joined with the session's own stop: the turn ends as one `close()` stops (the steps it finished stay in `messages()`, marked partial), a turn that had already failed when the signal aborted keeps its own error, and `close()` still stops a turn sent with a signal of its own. An agent's `generate()` and `stream()` pass an `abortSignal` in their options to `generateText()` and `streamText()`; with `runtime: 'gmi'` they take one too and end the same way ([GMIs from agent()](../GMI.md#gmis-from-agent)).

```ts
import { agent } from '@framers/agentos';

const session = agent({ provider: 'openai' }).session('support');
const turn = new AbortController();

const pending = session.send('Draft a reply to the last message.', { abortSignal: turn.signal });
turn.abort(); // the conversation moved on
await pending.catch((error) => console.log(error.name)); // 'AbortError'
```

## Attempts

```ts
import { generateText, type AttemptOutcome } from '@framers/agentos';

const outcomes: AttemptOutcome[] = [];
const { text } = await generateText({
  provider: 'openai',
  prompt: 'Name the largest moon of Saturn.',
  // One request: a 429, a 5xx, a timeout or a network failure throws, with no retry.
  maxAttempts: 1,
  onAttempt: (outcome) => outcomes.push(outcome),
});
console.log(text, outcomes); // ... [{ attempt: 1, status: 200, ok: true }]
```

`generateText()`, `streamText()`, `generateObject()`, `streamObject()` and `embedText()` take `maxAttempts` and `onAttempt`, which reach the provider as `ModelCompletionOptions`:

- `maxAttempts` is the most requests one call sends, a first and its retries together; the provider's configured count holds when it is left out (`maxRetries`, 3, on the OpenAI, Anthropic and Gemini providers; 3 on OpenRouter). A count that is not a whole number of 1 or more is refused with a `RangeError` before anything is sent. The OpenAI provider counts each call's attempts with `CountingAttemptBudget`, the attempt authorizer the voice platform calls before each of its requests ([Compound credit](../safety/SAFETY_PRIMITIVES.md#compound-credit)), so an attempt past the count is refused before it is sent. The Anthropic, Gemini and OpenRouter providers bound their retry loops by the same count, and none of the four waits a backoff after its last attempt, so `maxAttempts: 1` on a judge or classifier call turns a 429, a 5xx or Anthropic's 529 into an error at once, for the fallback chain or the caller to handle. A key hop inside an attempt ([Key rotation](../KEY_ROTATION.md)) is not counted. The Anthropic and Gemini streams send one request and retry nothing but key hops, and still refuse an invalid count before it is sent; OpenRouter's stream retries under the count. A request sent again on another route after a 404, a retired Gemini id on its alias or an OpenRouter request without its schema (when no endpoint takes `json_schema`), draws on the same count, the configured one when the call names none: it gets the attempts the first request left, and with none left the 404 ends the call. The other providers keep their configured retries.
- `onAttempt` is reported by the OpenAI provider (and the providers that send through it); the others report nothing. It is called once for each request the call sent, with an `AttemptOutcome`: `attempt`, the request's number in the call from 1; `status`, the HTTP status it answered, or `null` when none came (a timeout, a network failure, or the caller's abort once the request had begun); `ok`; and `usage`, present only on a request answered with an error status whose body reported tokens (as the wire spells them), which a later request's error would otherwise replace, so a caller that settles the whole call can count them. A request refused before it is sent is not reported, and a callback that throws never ends the call. A `generateObject()` validation retry is a call of its own, so its attempts count from 1 again; `embedText()` sends each batch once and reports it as attempt 1.

A caller settles against the report: a request whose usage never arrived (a timeout, an error after it was sent, a cut stream) is one the caller knows was sent.

## Prompt caching

```ts
import { generateText } from '@framers/agentos';

// A judge: the same rubric on every call, a new candidate each time.
const { text } = await generateText({
  model: 'anthropic:claude-haiku-4-5-20251001',
  system: [{ text: rubric, cacheBreakpoint: true }],
  prompt: candidate,
  // Keep the rubric's cache marker; put no breakpoint on the candidate.
  cache: { tail: false },
});
```

`generateText()`, `streamText()`, `generateObject()`, `agent({ cache })` and a fallback entry take `cache`, which reaches the provider as `ModelCompletionOptions.cache`. On Claude, directly and through OpenRouter's `anthropic/*` slugs, it decides the `cache_control` breakpoints a request carries:

- Left out (or `{ ttl: '5m' }`): the provider caches the request up to the newest message, so a conversation reads its history back from the cache on the next turn. A system block with `cacheBreakpoint: true` keeps its own marker, and the direct provider marks the newest message after it (OpenRouter sends a request that carries a caller marker as it is, a request-level `cache_control` in `customModelParams` included).
- `{ ttl: '1h' }`: the same markers with a one-hour TTL, for loops whose steps are more than five minutes apart.
- `{ tail: false }`: the markers the caller set go out as set, and the provider puts no breakpoint on the messages. For a call that sends the same long prefix every time and never the same tail (a judge, a classifier): the prefix is read back from the cache, and the tail, which no later call would read, is not written at the cache-write price (1.25x the input price at five minutes, 2x at one hour). With no `cacheBreakpoint` set, the end of the first system message is marked (the end of a `customModelParams.system` override when one replaces the system; on OpenRouter, the first system message of a `customModelParams.messages` override). It combines with `ttl`.
- `false`: no marker at all, the caller's included (on messages, tool definitions and a request-level `cache_control` in `customModelParams`), for a call whose prompt is never sent again.

Prices, floors and the per-provider behavior: [Prompt Caching](../features/PROMPT_CACHING.md).

## `agency().stream()`

`streamText()` is a single-call raw stream. `agency().stream()` separates raw
live chunks from the finalized post-guardrail/post-HITL answer:

```ts
import { agency, type AgencyStreamResult } from '@framers/agentos';

const team = agency({
  provider: 'openai',
  strategy: 'sequential',
  agents: {
    researcher: { instructions: 'Collect the key facts.' },
    writer: { instructions: 'Turn the facts into a concise answer.' },
  },
  hitl: {
    approvals: { beforeReturn: true },
    handler: async () => ({
      approved: true,
      modifications: { output: 'Approved for delivery.' },
    }),
  },
});

const stream: AgencyStreamResult = team.stream('Summarize HTTP/3 rollout risks.');

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk); // raw live output
}
process.stdout.write('\n');

for await (const approved of stream.finalTextStream) {
  console.log('Approved answer:', approved);
}

console.log('Agent calls:', await stream.agentCalls);
console.log('Final text:', await stream.text);
```

Use:

- `textStream` for low-latency token UX
- `finalTextStream` or `text` for the finalized approved answer
- `fullStream` when you also need structured events like `final-output`

See [Agency API](../orchestration/AGENCY_API.md) and [Streaming Semantics](../architecture/STREAMING_SEMANTICS.md)
for the full contract.

## [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts)

Use [`QueryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/QueryRouter.ts) when you want grounded answers over a local markdown corpus
without booting the full AgentOS runtime.

```ts
import { QueryRouter } from '@framers/agentos';

const router = new QueryRouter({
  knowledgeCorpus: ['./docs', './packages/agentos/docs'],
  availableTools: ['web_search'],
});

await router.init();

console.log(router.getCorpusStats());

const result = await router.route('How does memory retrieval work?');
console.log(result.answer);
console.log(result.tiersUsed);
console.log(result.fallbacksUsed);

await router.close();
```

`router.getCorpusStats()` returns a [`QueryRouterCorpusStats`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/query/types.ts) snapshot that tells
you what is actually live in the current host:

- corpus size: `configuredPathCount`, `chunkCount`, `topicCount`, `sourceCount`
- bundled platform knowledge: `platformKnowledge.total` plus per-category counts
- retrieval path: `vector+keyword-fallback` or `keyword-only`
- embedding health: `embeddingStatus`
- runtime truth: `graphRuntimeMode`, `rerankRuntimeMode`, `deepResearchRuntimeMode`

Built-in status meanings:

- `embeddingStatus: 'active'` means vector embeddings initialized successfully
- `embeddingStatus: 'disabled-no-key'` means init stayed keyword-only because no embedding credential was available
- `embeddingStatus: 'failed-init'` means vector init was attempted but fell back to keyword-only mode after an error
- `graphRuntimeMode: 'heuristic'` means same-document / heading-overlap expansion
- `rerankRuntimeMode: 'heuristic'` means the built-in lexical reranker
- `deepResearchRuntimeMode: 'heuristic'` means the built-in local-corpus research synthesis path

Hosts can inject real `graphExpand`, `rerank`, and `deepResearch` hooks in the
constructor; those modes then become `active`.

See [Query Router](../QUERY_ROUTER.md) for the full contract and host-hook examples.

## `generateImage()`

```ts
import { generateImage } from '@framers/agentos';

// Provider-first: resolves to gpt-image-2.5-flare by default for openai.
const result = await generateImage({
  provider: 'openai',
  prompt: 'A cinematic neon city skyline reflected in rain at night.',
  outputFormat: 'png',
});

console.log(result.provider);
console.log(result.images[0]?.mimeType);
```

## `removeBackground()`

```ts
import fs from 'node:fs';
import { removeBackground } from '@framers/agentos';

// The subject on a transparent PNG, as a URL on fal's storage.
const { image } = await removeBackground({ image: 'https://example.com/hero.png' });
console.log(image.url);

// The bytes instead, with the matte.
const pngBytes = fs.readFileSync('hero.png');
const { image: cut, mask } = await removeBackground({ image: pngBytes, output: 'buffer', returnMask: true });
```

The built-in provider runs fal's BiRefNet v2 (`fal-ai/birefnet/v2`) with `FAL_API_KEY`. Options:

| Option | Default | What it does |
|--------|---------|--------------|
| `image` | (required) | An `http(s)` URL or a base64 data URL of a PNG, JPEG, WebP or GIF, sent as given, or the bytes (`Buffer`, `Uint8Array`) of one. Any other string is refused. |
| `output` | `'url'` | `'url'` returns the cut-out's URL; `'buffer'` returns its `buffer` and `dataUrl` (fal is asked to answer inline). |
| `format` | `'png'` | `'png'` or `'webp'`. |
| `returnMask` | `false` | Also return the matte as `mask`; an answer without it rejects. |
| `model` | `'fal-ai/birefnet/v2'` | The fal endpoint. |
| `timeoutMs` | `60000` | The call's deadline, download included; rejects with `code: 'timeout'`. |
| `signal` | | Aborts the call with the signal's reason. |
| `apiKey`, `baseUrl` | `FAL_API_KEY`, `https://fal.run` | Credentials for this call. |
| `providerOptions.fal` | | `variant` (BiRefNet weights, default `'General Use (Light)'`), `operatingResolution` (default `'1024x1024'`), `refineForeground` (default `true`), `input` (extra request fields; the image, `output_mask` and `sync_mode` the call sets stand over them), `maxResponseBytes` (default 64 MiB). |
| `provider` | `'fal'` | A provider registered with `registerBackgroundRemovalProvider()`. |

Failures reject with `SegmentationProviderError` (`invalid_request`, `provider_failed` or `timeout`, with the HTTP `status` of a failed answer). See [Image Segmentation](../features/IMAGE_SEGMENTATION.md#background-removal).

## `probeProviderKey()`

```ts
import { probeProviderKey } from '@framers/agentos';

const keys = process.env.ANTHROPIC_API_KEY!.split(',').map((key) => key.trim()).filter(Boolean);
for (const apiKey of keys) {
  const { state, detail, fingerprint } = await probeProviderKey({ provider: 'anthropic', apiKey });
  console.log(fingerprint, state, detail);
  // 3f9a1c0b7e2d exhausted no credit or a spend limit reached (HTTP 400): Your credit balance is too low to access the Anthropic API. ...
  // 81c4e6a90d55 ok key accepted: HTTP 200 on claude-haiku-4-5-20251001
}
```

It sends one key through the same billing probe the provider's key pool sends to recheck a key it took out as unpaid. The probe is the smallest billable request, and its answer is read with `classifyKeyFailure()`: `ok` (a 2xx), `exhausted` (no credit left or a spend limit reached), `invalid` (a bad, revoked or expired key), `throttled` (a rate limit, with `retryAfterMs` when the answer sent one) or `unknown` (a 5xx, a 403 or 404 for a model the key may not use, no answer within the timeout, a failed connection, the caller's abort, or no model to send to). It reads no key from the environment and builds no pool; it never throws for an answer. The one variable that changes what it sends is `AGENTOS_OPERATION_ID_HEADER`, which names the header an Anthropic, OpenAI or OpenRouter probe's requests carry an operation id in ([Operation id across retries](../features/LLM_PROVIDERS.md#operation-id-across-retries)); a name those providers refuse rejects with a `RangeError` before any request.

| Option | Default | What it does |
|--------|---------|--------------|
| `provider` | (required) | `anthropic`, `openai`, `gemini`, `openrouter` or `requesty` (`PROBEABLE_KEY_PROVIDERS`); any other is refused with a `RangeError`. |
| `apiKey` | (required) | One key, trimmed; an empty key or a comma-separated list is refused with a `TypeError`. |
| `model` | the probe's model | Anthropic `claude-haiku-4-5-20251001`, Gemini `gemini-2.5-flash`, OpenAI the first GPT chat model `GET /models` lists, else its first o-series model with a price (never a Responses-only one), OpenRouter and Requesty the cheapest chat model their catalog lists with a price above zero. A named OpenAI model that is Responses-only goes to `POST /responses`. |
| `baseUrl` | the provider's endpoint | The API base as the provider's `baseURL` takes it; a blank string is unset. |
| `timeoutMs` | `10000` | How long the probe waits; a value that is not a positive finite number is refused with a `RangeError`, and one past 2147483647, the longest timer Node keeps, is cut to it. |
| `signal` | | Ends the probe, which reports `unknown`. |

The result carries `state`, `detail` (the state, the HTTP status and the vendor's message, at most 300 characters, with the key replaced by `[key]` wherever the vendor echoed it; on a failed connection, fetch's error with the key and the base URL's credentials replaced by `[redacted]`), `provider`, `fingerprint` (the key's `keyFingerprint()`), and `httpStatus`, `model` and `retryAfterMs` when the answer had them. A passing probe costs one request of one output token (16 on OpenRouter, Requesty and OpenAI's reasoning models). See [Key rotation](../KEY_ROTATION.md#probing-one-key).

## `generateVideo()`

```ts
import { generateVideo } from '@framers/agentos';

const result = await generateVideo({
  prompt: 'A drone flying over a misty forest at sunrise.',
  timeoutMs: 180_000,
  onProgress: (event) => console.log(event.status, event.progress, event.message),
  providerPreferences: {
    preferred: ['runway', 'replicate'],
    blocked: ['fal'],
  },
});

console.log(result.provider);
console.log(result.videos[0]?.url);
```

`image` routes the call to image-to-video and takes a `Buffer`, an `https://` URL or a `data:` URL. `resolution` and `referenceImages` go to text-to-video and image-to-video alike; `resolution` is sent in the model's own vocabulary (`720p`, `1080p`, or `512P` and `768P` for MiniMax on fal). `providerOptions` carry the model inputs the typed fields do not cover:

```ts
const clip = await generateVideo({
  provider: 'fal',
  model: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
  prompt: 'The lantern swings in the wind',
  image: 'https://cdn.example.com/lantern.png',
  resolution: '768P',
  providerOptions: {
    fal: { end_image_url: 'https://cdn.example.com/lantern-end.png', prompt_optimizer: false },
    // Used when Replicate runs as a fallback, on its default Kling 2.5 Turbo Pro.
    replicate: { end_image: 'https://cdn.example.com/lantern-end.png' },
  },
});
```

Key `providerOptions` by provider id so each provider in a fallback chain receives only its own entry (an id added with `registerVideoProviderFactory()` keys a bag as the built-in ids do); a bag with no provider-id key goes whole to fal, Replicate and Gemini. They add inputs and never replace a field the call sets, so to send a model-specific value for such a field, leave the typed field unset and put the value there. Runway sends the prompt, `duration`, `ratio` (from `aspectRatio`) and the source image; it sends no `resolution`, reference images or provider options. A custom provider registered with `registerVideoProviderFactory()` receives `image` as the caller passed it, a `Buffer` or a string, and `videoImageToUrl()` turns either into a URL. `timeoutMs` goes to each provider at `initialize()`: the polling budget on fal, Replicate and Runway, and the deadline of every request on Gemini, which rounds a fractional value up to whole milliseconds and refuses one past 2147483647, the longest timer Node keeps.

### Built-in Video Providers

| Provider    | Default model                                                                        | API key env var       | Image input                                                        |
| ----------- | ------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------ |
| `runway`    | `gen3a_turbo`                                                                        | `RUNWAY_API_KEY`      | `prompt_image`                                                     |
| `replicate` | `kwaivgi/kling-v2.5-turbo-pro`                                                       | `REPLICATE_API_TOKEN` | `start_image` (Kling), `first_frame_image` (MiniMax), else `image` |
| `fal`       | `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` (its `image-to-video` for an image) | `FAL_API_KEY`         | `image_url`                                                        |
| `gemini`    | `gemini-omni-1.1-flash`                                                              | `GEMINI_API_KEY`      | an inline image part                                               |

With no `provider`, AgentOS picks the first of `RUNWAY_API_KEY`, `REPLICATE_API_TOKEN` and `FAL_API_KEY` that is set and keeps the others as fallbacks. `gemini` runs only when `provider: 'gemini'` names it, so a Gemini key set for text never starts a video job.

- **fal** sends the image and `referenceImages` as `image_url` and `reference_image_urls` (a URL as given, a `Buffer` as a `data:` URL), plus `resolution`, `negative_prompt`, `aspect_ratio` and `seed`. Kling and MiniMax endpoints take `duration` as a string (`"5"`, `"10"`; `"6"`, `"10"`), and the provider sends it that way. It polls the `status_url` and fetches the `response_url` fal returns, and raises a request that ends `COMPLETED` with an `error`.
- **Replicate** posts `{ version: model, input }`, where `model` is `owner/name`, `owner/name:version` or a version id. It sends `referenceImages` as `reference_images`, plus `resolution`, `negative_prompt`, `duration`, `aspect_ratio` and `seed`. A bare version id names no model family, so its image goes as `image` unless `providerOptions: { replicate: { imageInputName: 'start_image' } }` names the field; `imageInputName` itself is not sent.
- **Gemini** runs Gemini Omni Flash on the Interactions API (`POST /v1beta/interactions`, key in the `x-goog-api-key` header). The source image, then the reference images, then the prompt go as input parts; `aspectRatio` (`16:9`, `9:16`) and `resolution` (`360p`, `720p`, `1080p`, `4k`) go in `response_format`. It fetches an image URL itself through the checked egress path (`https` on port 443 to a name whose every address is public, the connection pinned to the checked address, each of up to 3 redirects checked the same way, 20 MiB read across a call's images, redirect bodies included), sends the bytes inline without the API key, decodes a base64 or percent-encoded `data:` URL (counted against the same bound), and sends a Files API URI as a `uri` part. The provider's own `imageEgress: { profile: 'local' }` allows `http` and private addresses for a developer's machine, and `maxImageBytes` changes the bound (a value past `Number.MAX_SAFE_INTEGER`, `Infinity` included, is refused). It returns the video as base64; with `providerOptions: { gemini: { response_format: { delivery: 'uri' } } }`, which the Omni guide recommends for videos over 4 MB, it polls the Files API file until it is `ACTIVE`, downloads it with the key, and returns the bytes as base64 with the URI in `providerMetadata.fileUri` ([URI delivery](https://ai.google.dev/gemini-api/docs/omni#retrieving-videos-with-an-uri)). `providerOptions.gemini.background: true` is refused before any image is fetched, since the provider does not poll a background interaction. `pollIntervalMs` sets the pause between Files API polls and, like `timeoutMs`, is refused past 2147483647. Google shut down the Veo models in the Gemini API (`veo-3.0-*` on 30 June 2026, the `veo-3.1-*-preview` models on 22 October 2026) and names `gemini-omni-1.1-flash` as their replacement ([deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [Omni guide](https://ai.google.dev/gemini-api/docs/omni)).

## `analyzeVideo()`

`analyzeVideo()` auto-creates a [`VisionPipeline`](https://github.com/framerslab/agentos/blob/master/src/io/vision/VisionPipeline.ts), uses the structured
[`VideoAnalyzer`](https://github.com/framerslab/agentos/blob/master/src/io/media/video/VideoAnalyzer.ts) pipeline under the hood, and auto-wires STT when a supported
speech provider credential is available (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`,
`ASSEMBLYAI_API_KEY`, or Azure Speech env vars).

```ts
import { analyzeVideo } from '@framers/agentos';

const result = await analyzeVideo({
  videoUrl: 'https://example.com/demo.mp4',
  prompt: 'What is the product demo showing?',
  transcribeAudio: true,
  maxFrames: 12,
});

console.log(result.description);
console.log(result.fullTranscript);
console.log(result.scenes?.length);
```

Host requirement: `ffmpeg` and `ffprobe` must be installed and available on `PATH`.

## `generateMusic()` and `generateSFX()`

```ts
import { generateMusic, generateSFX } from '@framers/agentos';

const music = await generateMusic({
  prompt: 'Warm analog synthwave with a slow build.',
  timeoutMs: 180_000,
  onProgress: (event) => console.log('music', event.status, event.message),
  providerPreferences: {
    preferred: ['suno', 'udio'],
  },
});

const sfx = await generateSFX({
  prompt: 'Heavy vault door closing with metallic reverb.',
  timeoutMs: 60_000,
  onProgress: (event) => console.log('sfx', event.status, event.message),
  providerPreferences: {
    preferred: ['elevenlabs-sfx', 'stable-audio'],
  },
});

console.log(music.audio[0]?.url);
console.log(sfx.audio[0]?.url);
```

### Cloud audio providers

| Provider          | Endpoint                                                                 | Music default            | SFX default            | API key env var       |
| ----------------- | ------------------------------------------------------------------------ | ------------------------ | ---------------------- | --------------------- |
| `stable-audio`    | `POST https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio` (multipart) | `stable-audio-2.5`       | `stable-audio-2.5`     | `STABILITY_API_KEY`   |
| `replicate-audio` | `POST https://api.replicate.com/v1/predictions`, or `/v1/models/{owner}/{name}/predictions` for official models | `meta/musicgen` (version pinned) | `sepal/audiogen` (version pinned) | `REPLICATE_API_TOKEN` |
| `fal-audio`       | `POST https://queue.fal.run/{model}` (queue)                             | `fal-ai/musicgen`        | `fal-ai/stable-audio`  | `FAL_API_KEY`         |

- `stable-audio` accepts `stable-audio-2.5` and `stable-audio-2`. `outputFormat` takes `mp3` (the default) or `wav`, and primitive `providerOptions` such as `steps` and `cfg_scale` become form fields.
- `replicate-audio` takes `owner/name`, `owner/name:version` or a bare version id. Replicate runs community models only by version, so `meta/musicgen` and `sepal/audiogen` carry pinned versions, and the retired `meta/audiogen` id resolves to `sepal/audiogen`. Any other `owner/name`, such as `stability-ai/stable-audio-2.5`, runs on the official-model route. An `owner/name:version` or bare version id is reported in the result as given. `outputFormat` `wav` or `mp3` is sent as the model's own `output_format` value (`wav`/`mp3` for MusicGen and AudioGen, `wav_cd_quality`/`mp3_standard` for `elevenlabs/music`, nothing for `stability-ai/stable-audio-2.5`); `flac`, `ogg` and `aac` are left to the model's default. The result's MIME type is read from the output URL's extension, then from the format sent, and is `audio/mpeg` when neither names one. `durationSec` is sent as `duration`, or as `music_length_ms` in milliseconds for `elevenlabs/music`. `seed` is sent to every model except AudioGen and `elevenlabs/music`, which take none. `providerOptions` add model inputs (for example `{ model_version: 'stereo-large' }` for MusicGen) and never replace the prompt, duration, output format or seed.
- `fal-audio` sends `seconds_total` to Stable Audio models and `duration` to the others, and `providerOptions` add model inputs without replacing the prompt, duration or seed. Status polls and the result fetch stay on a custom `baseURL`. The provider reads the model's `audio`, `audio_file` or `audio_url` output. A request that fails in the queue is raised with fal's `error` text.
- When no `model` is given, `generateSFX()` runs each provider on its SFX default, not on its music default.

```ts
const loop = await generateMusic({
  provider: 'replicate-audio',
  model: 'meta/musicgen',
  prompt: 'Slow ambient pads for a rainy night',
  durationSec: 30,
  outputFormat: 'wav',
  providerOptions: { model_version: 'stereo-large', normalization_strategy: 'peak' },
});
```

## Media Provider Preferences

Image, video, music, and SFX helpers accept `providerPreferences` so callers can
reorder, block, or weight providers without hard-coding a single backend:

```ts
import type { MediaProviderPreference } from '@framers/agentos';

const preferredCloudOnly: MediaProviderPreference = {
  preferred: ['runway', 'replicate'],
  blocked: ['musicgen-local', 'audiogen-local'],
  weights: { runway: 3, replicate: 1 },
};
```

When `weights` are present, AgentOS chooses the primary provider from the
resolved list using weighted selection and keeps the remaining providers in
order as fallbacks.

### Built-in Image Providers

| Provider                 | Type      | Default model                    | API key env var       |
| ------------------------ | --------- | -------------------------------- | --------------------- |
| `openai`                 | Cloud API | `gpt-image-2.5-flare`            | `OPENAI_API_KEY`      |
| `stability`              | Cloud API | `stable-diffusion-xl-1024-v1-0`  | `STABILITY_API_KEY`   |
| `replicate`              | Cloud API | `black-forest-labs/flux-1.1-pro` | `REPLICATE_API_TOKEN` |
| `openrouter`             | Cloud API | —                                | `OPENROUTER_API_KEY`  |
| `bfl`                    | Cloud API | `flux-pro-1.1`                   | `BFL_API_KEY`         |
| `fal`                    | Cloud API | `fal-ai/flux/dev`                | `FAL_API_KEY`         |
| `minimax`                | Cloud API | `image-01`                       | `MINIMAX_API_KEY`     |
| `stable-diffusion-local` | Local     | `v1-5-pruned-emaonly`            | None (uses `baseUrl`) |

Ollama serves text and embeddings only: `generateImage({ provider: 'ollama' })` throws `Image generation is not supported for provider "ollama"`.

### Provider-Specific Options

Use the common options for the simple path, then drop down to namespaced
`providerOptions` when you need provider-native controls:

```ts
import { generateImage } from '@framers/agentos';

const poster = await generateImage({
  provider: 'stability',
  model: 'stable-image-core',
  prompt: 'An art deco travel poster for a moon colony',
  negativePrompt: 'text, watermark',
  providerOptions: {
    stability: {
      stylePreset: 'illustration',
      seed: 42,
      cfgScale: 8,
    },
  },
});

console.log(poster.images[0]?.mimeType);
```

Replicate and OpenRouter work the same way:

```ts
const replicateResult = await generateImage({
  provider: 'replicate',
  model: 'black-forest-labs/flux-schnell',
  prompt: 'A product photo of a titanium watch on black stone',
  aspectRatio: '16:9',
  providerOptions: {
    replicate: {
      outputQuality: 90,
      input: {
        go_fast: true,
      },
    },
  },
});
```

### Local Image Generation

Run Stable Diffusion locally without any API key, through an Automatic1111 or Forge WebUI (`/sdapi/v1/txt2img`) or ComfyUI (`/prompt`) server:

```ts
const sdLocal = await generateImage({
  provider: 'stable-diffusion-local',
  model: 'v1-5-pruned-emaonly',
  prompt: 'A brutalist house in fog',
  baseUrl: 'http://localhost:7860', // or set STABLE_DIFFUSION_LOCAL_BASE_URL
});
```

### Custom Image Provider

Register a provider factory for backends not covered by the built-ins:

```ts
import { generateImage, registerImageProviderFactory, type IImageProvider } from '@framers/agentos';

class ComfyUIProvider implements IImageProvider {
  providerId = 'comfyui';
  isInitialized = false;
  defaultModelId = 'sdxl';

  async initialize() {
    this.isInitialized = true;
  }

  async generateImage(request) {
    return {
      created: Math.floor(Date.now() / 1000),
      modelId: request.modelId,
      providerId: this.providerId,
      images: [{ url: 'https://example.invalid/image.png' }],
      usage: { totalImages: 1 },
    };
  }
}

registerImageProviderFactory('comfyui', () => new ComfyUIProvider());

await generateImage({
  provider: 'comfyui',
  model: 'sdxl',
  prompt: 'A brutalist house in fog',
});
```

## `agent()`

```ts
import { agent } from '@framers/agentos';

const researcher = agent({
  provider: 'openai',
  instructions: 'You are a concise research assistant.',
  maxSteps: 4,
});

const session = researcher.session('demo');

const first = await session.send('What is QUIC?');
console.log(first.text);

const second = await session.send('Compare it to TCP.');
console.log(second.text);

console.log(await session.usage());
```

`agent({ tools })` accepts the same three forms as `generateText({ tools })`
and `streamText({ tools })`: named tool maps, [`ExternalToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/externalToolRegistry.ts)
(`Record`, `Map`, or iterable), and prompt-only `ToolDefinitionForLLM[]`.
A tool an agent calls receives the session's user in `context.userContext.userId`
(the session id when the session named none, the call's own id on `generate()`
and `stream()`) and the subject its memory is keyed by in
`context.userContext.memorySubject`; a direct `generateText()` call passes `system`.

### Guards on an agent's calls

`generate()`, `stream()` and a session's `send()` and `stream()` take `guards` per
call, as [`generateText()`](#guards-on-a-call) and [`streamText()`](#guards-on-a-stream) do:

```ts
const reply = await session.send(message, { guards });
const live = session.stream(message, { guards });
```

- A schema retry is a call of its own: the retry's input stage judges its
  correction turn, and the turns it repeats hold the text that was delivered.
  A send whose input a guard replaced is not retried: no request is made and
  the replacement is validated as the reply. It resolves when the replacement
  fits the schema, and rejects with `ObjectGenerationError`, whose `rawText` is
  the replacement, when it does not.
- A session's history holds what was delivered. A reply a guard rewrote or
  replaced is stored as delivered, a send whose input a guard rewrote stores
  the rewritten turn, and a send whose input a guard replaced adds nothing. A
  stream turn whose input a guard rewrote or replaced is not added to the
  history. A sanitizer that returned the turn's text unchanged rewrote
  nothing: the turn is kept and observed as any other.
- A memory provider's `getContext()` recalls for the turn as it was sent, a
  rewritten turn's text included, and its `observe()` is not called for a turn
  whose input an enforced guard rewrote or replaced, a turn whose schema retry
  then passed included.
- `verifyCitations` retrieves with the turn as it was sent, a rewritten turn's
  text included, and does not run for a turn a guard replaced.
- The `guardrails` ids in an `agent()` or `agency()` config are stored and not
  applied: a call is guarded by its `guards`. A panel agency's call cannot
  carry `guards`.
- An agent with `runtime: 'gmi'` does not enforce `guards`: its `generate()`,
  `stream()` and a session's `send()` and `stream()` throw when a call
  carries them, before any turn starts.

### Citation verification

Set `verifyCitations: { embedFn, retrieve }` to check generated claims against
sources retrieved for the original user input. `retrievalAugmentor` can supply
both hooks instead. The reply is returned unchanged: verification adds verdicts,
not a filter. Missing retrieval wiring, empty sources or verification failure
leave grounding undefined.

`generate()` returns these verdicts in `result.grounding`. On the default
runtime, session `send()` does the same, including after a successful schema
retry. Session `stream()` exposes `result.grounding` as a promise; consume the
stream before awaiting it, because verification starts only after the text
completes. Direct `stream()` and GMI session calls do not run this check.

```ts
const session = agent({
  provider: 'openai',
  verifyCitations: { embedFn, retrieve }, // Supply the embedding and retrieval functions.
}).session();

const reply = await session.send('Summarize the retrieved records.');
const verdicts = reply.grounding?.claims;

const streamed = session.stream('Explain the summary.');
for await (const text of streamed.textStream) process.stdout.write(text);
const streamedVerdicts = await streamed.grounding;
```

### Schema validation and retries

On the default runtime, `agent({ responseSchema })` validates `generate()`'s
final text with the supplied Zod schema and returns the value in `result.parsed`.
It can extract JSON from a code fence. `controls.maxValidationRetries` defaults
to 1, so an invalid reply gets one more attempt. Set it to 0 to throw
`ObjectGenerationError` on the first invalid reply.
`output` is the `agency()` option: `agent()` accepts it, does not apply it
and names it in its construction warning, so pass an agent's schema as
`responseSchema`.
Repair attempts retain the completed transcript, including native tool calls
and their results, and run without tools so they cannot repeat an action.

For a session, pass the schema to `send()` and read `result.object`:

```ts
import { z } from 'zod';

const result = await session.send('Count the records.', {
  responseSchema: z.object({ count: z.number() }),
  maxValidationRetries: 1,
});
```

Session sends default to zero extra attempts. Each retry includes the failed
reply and validation feedback. Only the original user input and final valid
reply enter session history; an exhausted send adds nothing. Usage totals count
every completed attempt. Retry counts must be non-negative integers. Schema
sends omit configured tools and their chain-of-thought instruction, as before.
These retry options apply to the default runtime.

For schema calls, `memoryProvider.observe` records the original user input once
and only the accepted answer, after caller hooks and validation. Failed attempts
and exhausted retries record nothing. Memory retrieval runs once for the call and
its recall reaches every attempt; caller generation hooks run on every attempt.

A turn never waits for `memoryProvider.observe`, and an `observe` that throws or
rejects leaves the turn's result as it is. The failure is logged as a
`memory.hook_failed` event, with the error's type and code and never its
message, on the provider's first failure and then at its 10th, 100th, 1000th and
so on, on the default runtime and on `runtime: 'gmi'`.

### Working-memory block

On the default runtime, `memory: { working: () => 'STATE: ...' }` supplies a
system-text block for each session `send()`. The callback may return a promise.
It runs once per send, including sends with schema retries, and its text precedes
the configured system text. An empty block is skipped. A thrown error or rejected
promise skips the block and warns through the configured logger factory, without
logging the error or state text.

The host owns the state. This callback creates no store and does not run on
`generate()`, direct `stream()`, session `stream()` or the GMI runtime. The existing
`working: { enabled, maxTokens, strategy }` buffer configuration remains accepted
and deferred by the default runtime.

### Sessions served by GMIs: `runtime: 'gmi'`

```ts
import { agent } from '@framers/agentos';

const tutor = agent({
  runtime: 'gmi',
  provider: 'openai',
  instructions: 'You are a patient networking tutor.',
  memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } },
});

const session = tutor.session('demo', { userId: 'learner-42' });
await session.send('What is QUIC?');
await tutor.close();
```

With `runtime: 'gmi'` (or [`gmi()`](https://github.com/framerslab/agentos/blob/master/src/api/gmi.ts), the same function under its own name), every session is a Generalized Mind Instance built from the options, and `memory` turns on cognitive memory: one manager for the sessions, scoped per user, embedding with `memory.embedding` (unset, a model picked from the global default provider or the environment's keys). `cognition: 'full'` adds sentiment tracking and the metaprompt presets. Of the `MemoryConfig` fields, this path reads `embedding`, `consolidation`, `persistAccessState`, `store` and `recall`; it does not read `types`, `working` or `shared`. `memory.store` (`{ path }`, a SQLite file, or `{ adapter, brainId? }`, a host's storage adapter) keeps the agent's memory and its learning store there, so an agent built again on it recalls what its users said; it needs `learning.agentKey`. The default runtime reads only the `memory.working` callback described above and `memory.recall.budget.totalTokens` (below). [GMIs from agent()](../GMI.md#gmis-from-agent) lists what each option does on this path.

`memory.recall` sets the memory block's budget and what each turn records of its recall:

```ts
const tutor = agent({
  runtime: 'gmi',
  provider: 'openai',
  memory: {
    embedding: { provider: 'openai' },
    recall: { budget: { totalTokens: 2400 }, capture: 'off' },
  },
});
```

| Field | Default | What it does |
|---|---|---|
| `budget.totalTokens` | 1600 | The budget of the whole memory block a turn sends, its preamble included, in tokens of about four characters. An integer of at least 0; at 0 the turn sends no block. A model whose share of the prompt for retrieved context (20% of its context, less the turn's RAG and long-term-memory text) is smaller is sent the block rendered again at that remainder, from the same recall ([Budget and the prompt share](../memory/COGNITIVE_MEMORY.md#budget-and-the-prompt-share)). |
| `capture` | `'metadata'` | What a turn records of its recall: `'metadata'` puts the record on a session's `send()` result (`memoryRecall`) and on its `stream()` result (a `memoryRecall` promise, which also settles with the record when the turn fails after its memory assembly), `'off'` records nothing. `'metadata+stream'` records the same on these sessions, whose `stream()` parts carry no memory part; the record goes on a runtime stream only for a host of `AgentOS.create()` whose memory manager sets that value. The record holds ids, ranks, scores, counts and timings, never a memory's text ([Recall Capture](../memory/COGNITIVE_MEMORY.md#recall-capture)). |

The construction rules:

- With `runtime: 'gmi'` and memory on, both fields go to the agent's memory manager, and `memoryProviderOptions.tokenBudget` does not size the block. When it is set and no `memoryProvider.getContext` reads it, the agent writes one `memory.recall.option_ignored` line at construction (`generate()` and `stream()` run without cognitive memory and still pass it to a provider's `getContext`).
- A `cognition.memory` of the agent's own replaces `memory` for cognitive memory, its `recall` included: set `recall` inside `cognition.memory`. A `memory.recall` set beside it is applied nowhere, and the agent writes one `memory.recall.option_ignored` line at construction (`option: 'memory_recall'`).
- Without `runtime: 'gmi'`, or with memory off, `budget.totalTokens` is the `tokenBudget` handed to `memoryProvider.getContext` when `memoryProviderOptions.tokenBudget` is unset; the two set to different values throw at construction naming both, and `capture` throws: no cognitive memory runs to record anything. With no `memoryProvider.getContext` to read it, a set `budget.totalTokens` is applied nowhere, and the agent writes one `memory.recall.option_ignored` line at construction (`option: 'recall_budget'`).
- A `budget.totalTokens` that is not an integer of at least 0, a `capture` outside its three values, or a `recall` or `budget` that is not an object (`recall: 'off'`, `budget: 2400`), throws a `RecallOptionError` at construction naming the field.

Each refusal writes one `memory.recall.option_rejected` line before the throw.

`learning: true`, or a `LearningConfig`, turns on the agent's learning layer: every GMI of the agent sends the persona's personality section as a system prompt of its own on every turn, in the words `agent()` writes, a session opened with a `userId` is bound to a learner when the id is not one the layer reads as anonymous (`anonymous_user`, `guest` and the others, with `learning.anonymousUserIds`) and the agent has a `name` or `learning.agentKey`, and `agent.learning.manifest()` says which loops run. `agent.learning` also carries the operator's calls (`freeze`, `unfreeze`, `suspend`, `unsuspend`, `operatorSet`, `revert`, `exportLearnedState`, `importLearnedState` and `forgetUser`), with the agent's key and namespace filled in. Unset or `false` (the default), the agent builds no layer and the persona's base prompt carries the section; `agent()` without `runtime: 'gmi'` ignores the option. [Learning](../GMI.md#learning) has the rules.

### Per-agent identity via SOUL.md

Pass a `soul:` option to give an agent its identity from a SOUL.md workspace. `agent()` builds its system prompt from the SOUL.md body first, then a `## Style` section from STYLE.md, then the `memory/index.md` catalog, then `instructions`, `name`, `personality` and skills. A soul that fails to load throws `SoulLoadError` when the agent is built; pass `soul: { path, optional: true }` to run without it.

```ts
// Workspace path: SOUL.md, STYLE.md and memory/index.md shape the prompt
agent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });

// Direct file path: read as SOUL.md, with the companion files beside it
agent({ provider: 'openai', soul: './personas/aria.soul.md' });

// Inline content: for tests and ephemeral agents
agent({ provider: 'openai', soul: { content: SOUL_MARKDOWN_STRING } });
```

`agent({ soul })` applies the front matter it has a renderer for: the `hardLimits` close the system prompt as a "Hard limits" block, after `systemBlocks` too, the `hexaco` scores render as the trait paragraph when no `personality` is set, and the soul's `name` is the name line when no `name` is set. An option set in code wins over the file. Mood, voice, avatar and the reasoning-trace limits have no renderer on this path. See [SOUL_FILES.md](../SOUL_FILES.md) for the workspace files.

### `souledAgent()`: soul plus a `memory/` wiki

`agent({ soul })` loads identity but leaves long-term memory to you. `souledAgent()` is the async factory that wires the whole loop in one call: it loads the soul, opens one `Memory` store under the workspace's `memory/.store/`, indexes the operator's pages under `memory/`, and keeps what each subject says (the session's `userId`, else the session) in that store, apart from every other subject's.

```ts
import { souledAgent } from '@framers/agentos';

const aria = await souledAgent({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  soul: '~/.agentos/agents/aria',
});
```

What it wires:

- **Read:** the index of the operator's pages is injected into the system prelude, and the agent opens a page on demand with the `read_memory_page` tool: `{ "id": "<page id>" }` reads one, and `{ "list": true }` lists what the asker can read. The tool answers the asker's own pages and the operator's; another user's page answers as a page that does not exist, and a call that names a scope or a user is refused. The tool is added when `tools` is absent or an array; a named tool map is passed through as given, without it.
- **Recall:** once per turn, before its first model call, the traces that match the user's message are read from two places and no other: up to eight from the memory of the turn's subject (the user the session named with `userId`, else the session itself) and up to eight from the operator's pages. Nothing another user or another session said is read. They are sent with the turn as data, best match first: a `<memory_recall>` block of JSON in a user-role message right before the turn's own, one record each with who spoke it (`user`, `assistant`, or `note` and the page id for a chunk of a wiki page; none for a trace stored before speakers were recorded), the date it was stored (`26 days ago, 2026-10-14`) and its text, with `^` in place of each run of whitespace (a line break included), kept to the turn's memory token budget (`memoryProviderOptions.tokenBudget`, 2,000 tokens by default, estimated at about four characters a token): whole lines in rank order while they fit, and the first trace's text cut at a word boundary when its line alone is larger (never inside a character). The budget caps the recalled text; the block adds its tags, a note, each record's keys and the escapes of `<`, `>` and `&` beyond it. A budget of 0 adds no recall block. Recall is full-text search unless the store is given an embedder. The block is marked as data and the system prompt says so in one line; that lowers the chance that a stored sentence is followed as an instruction and does not remove it.
- **Capture:** conversation the agent observes is written to the same store as episodic traces, each filed under the key of its turn's subject, the user's message and the reply alike: the user the session named with `userId`, else the session itself (`agent.session(id, { userId })`; an id that names nobody, such as `system` or `guest`, counts as none). A one-shot `generate()` or `stream()` names no user, so nothing is filed for it and it recalls the operator's pages alone; one `memory.one_shot_unfiled` log line an agent says so. Each trace records who spoke it in its metadata (`speaker: 'user'` or `speaker: 'assistant'`), outside its text and tags, so recall never matches a trace by its speaker. These traces carry no entities, so the default clusterer merges them all into the page `concepts/notes`. Entity pages come from traces stored with entities through `agent.memory.remember()`, or from a clusterer passed to `attachMemoryWiki()`. A write for a forgotten user or session is refused, or taken back when it lands after the tombstone; recall and `read_memory_page` answer nothing for them (`memory.write_refused`, `memory.compile_skipped` and `memory.page_read_refused`, each with `reason: 'forgotten'`).
- **Fold:** those traces are merged into wiki pages when memory consolidates, once a subject: each subject with new traces is compiled from its own traces alone into its own pages, which are rows of the store and never files under `memory/`, and each subject has its own watermark. Each page written is dated with the time of the compile. `souledAgent` compiles the subjects its turns wrote to on the agent's `close()`; call `await aria.memory.compileWiki()` to fold every subject with new traces mid-session. A merge integrates new facts into the subject's page; a page the operator wrote under `memory/` is never read or rewritten by a compile. The compile's prompt quotes the traces as JSON records under a line that says they are conversation data, not instructions. A page the compile creates gets a summary named from its page id (`Notes compiled from conversations` for `concepts/notes`), never copied from a trace, so no sentence a user says becomes a line of `index.md` and of the system prompt (an entity page's id, `entities/johnny`, still carries the name the compile found in the conversation); a page that has a summary keeps it. `close()` first closes the agent (on `runtime: 'gmi'` that stops its session turns), then waits up to 5 seconds (`pendingWritesTimeoutMs`), one deadline, for the turns still running (a `generate()`, a `stream()`, a session's `send()` or `stream()`, on either runtime) and then for the memory writes of its turns, then compiles, then closes the store; turns or writes still pending when the wait ends are counted in one warning line and are not folded into the wiki, a stream whose `abortSignal` aborted before anything was read from it is not waited for, and on the default runtime a stream nobody reads and nobody aborts keeps the wait until the deadline. The compile's model calls use the agent's route, fallback settings, completion cap (`maxTokens`) and `budget`, and are written to its usage ledger under the source `souledAgent.compileWiki`. A call the budget refuses skips that subject with one `memory.compile_skipped` log line (`reason: 'budget'`): its traces wait for the next compile, and the other subjects compile. A compile that fails on `close()` for any other reason logs a warning naming the error; the conversation traces stay in the store for the next compile, and `close()` still closes the agent and the store.
- **One person's memory:** `sharedMemory: { as: 'me', reason: 'one-persons-machine' }` (or `reason: 'operators-notes'`) is for one person's own machine, or an operator's own notes: every session that names no user, and every one-shot call, runs as the user `as`, so they share one memory, and `read_memory_page` reads that user's pages. It has three refusals: a session that names another user throws, opening a store that already holds the memory of another user or session rejects (the store is closed first), and an agent with cognitive memory on is refused it, since the GMI's cognitive memory keeps a store of its own. Without the option, pass one stable `userId` on every session to the same end.
- **The store's folder:** `memory/.store/` gets a `.gitignore` holding `*` when it is made, so what people said stays out of version control; a `.gitignore` already there is left as it is. Traces an earlier version filed under the agent's plain id stay in the store, are read by no turn, and are counted in one `memory.legacy_traces` log line at start.
- **Legacy `MEMORY.md`:** its text is copied once into `memory/index.md` between the markers `<!-- migrated from MEMORY.md -->` and `<!-- end of MEMORY.md -->`, right under its `# Memory Index` heading, with an end marker that `MEMORY.md` itself holds copied as `<!-- end of MEMORY.md (quoted) -->` so it closes nothing; a start marker anywhere else, such as in a page summary, is catalog text. The catalog the wiki writes goes after that block, so the text stays in the index and in the system prompt; `MEMORY.md` itself is never changed.

Three options say what is kept and where it goes:

- **`compile`** names where the compile's model calls go. Unset, they go on the agent's own provider and model, with its route, budget and ledger. An object (`{ provider?, model?, apiKey?, baseUrl? }`) names another provider or model, a local one included: the compile's text then goes to that provider alone, with no fallback and no router. A `model` whose `provider:` prefix names another provider (`'anthropic:claude-sonnet-4-6'` on an OpenAI agent) takes the compile there, and the agent's own key and base URL go with it only when the compile's call resolves to the provider they were set for, whether the agent names that provider or only its model does; otherwise the compile runs on the target's own `apiKey`, or that provider's key from the environment. A target that names a provider alone runs on that provider's default model, unless it is the agent's own provider, whose model it keeps. `compile: false` runs no compile: turns are kept as raw traces, no per-user page is ever written, and one `memory.compile_skipped` log line (`reason: 'compile_off'`) says so at start.
- **`memoryPolicy`** is the host's policy for the account a turn serves: a function of the turn's context (`sessionId`, `userId`, `subject`, `call`) that answers `{ longTerm: 'off' }` (nothing is filed for the account and its turns recall the operator's pages alone; one `memory.write_refused` line, `reason: 'policy_off'`, a session), `{ longTerm: 'raw' }` (its turns are filed and recalled, and no page is compiled for it; a compile that meets it writes `memory.compile_skipped` with `reason: 'policy_raw'`) or `{ longTerm: 'compiled' }` (the default). It is asked once a session and its answer is kept for that session's subject until the session closes; an answer that comes after the session closed is kept for nothing, so a session id opened again for another user asks again. Each turn keeps the answer it began with until its reply is filed, even when another turn of its session overlaps it. The page tool and the compile follow the host's latest answer for the account: under `off`, or when the hook failed, `read_memory_page` serves the account none of its own pages, in reading or in its listing (the operator's pages alone), and no compile runs for it, whatever answer an older session keeps. The latest answer is the one asked for last: an answer the host gives late to an earlier ask decides that ask's turn and nothing more. A compile reads the latest answer again once the `screen` hook has answered for its traces, so an `off` answer given meanwhile stops it. A hook that throws, rejects, does not answer within the memory hooks' timeout (`memoryProviderOptions.timeoutMs`, 5 seconds by default) or answers anything else fails closed: one `memory.hook_failed` line (`hook: 'memoryPolicy'`), nothing is filed for that turn (`memory.write_refused`, `reason: 'policy_failed'`, a write), the turn recalls the operator's pages alone, and the next turn asks again.
- **`screen`** is given each text before it is filed, and so before it is embedded (`stage: 'file'`), and each trace's text again before it is sent to a compile (`stage: 'compile'`). The string it returns is what is filed or compiled; `null` drops the text (`memory.write_refused`, `reason: 'screened'`). Any string it returns is text, the word `failed` among them. A hook that throws, rejects, times out or answers anything else fails closed: `memory.hook_failed` (`hook: 'screen'`), the text is not filed (`reason: 'screen_failed'`), and a compile it fails for does not run (`memory.compile_skipped`, `reason: 'screen_failed'`), its traces waiting with their watermark where it was.

A compile started in a process that served no turn of a subject has no policy answer and no hook context for that subject: with `memoryPolicy` set it is not compiled (`policy_raw`), and with `screen` set neither (`screen_failed`); its traces wait for a process that serves the subject. No log line of these carries a user id, a page id or any text. The hooks decide what is kept and compiled; they are not a check that a text is free of personal data. They act on the souled agent's own store alone, as `sharedMemory` does: `souledAgent()` refuses any of the three, with a `TypeError` and nothing opened, on `runtime: 'gmi'` with cognitive memory on (`cognition.memory`, the `full` profile, or the `memory` option), whose GMI files and recalls in a store of its own.

Retention:

- **`retention: { traces, sessions?, pages? }`** sets how long conversation traces are kept from the time they were stored (`{ days }`, or `'until-deletion'`), with a period of its own for anonymous sessions (`sessions`). A store that holds, or would hold, a second user or session does not open, and opens no second subject's session, without it: a session with no `userId` is a subject of its own, so a product that opens one anonymous session a visitor chooses a period. One stable `userId`, or `sharedMemory`, is one subject and needs none, and a one-shot `generate()` or `stream()` that names no user files nothing and is no subject. When a trace expires, a page compiled from it is deleted whole, or rebuilt by the next compile from the traces that survive with `pages: 'rebuild'` (one model call a page). The sweep runs on `close()`, before the compile, and by `await agent.sweepRetention()`, which answers `{ traces, pages, scopes }`; one `memory.retention_swept` log line counts the same. Operator pages and memory from before per-user scope are never swept. A `retentionDays` on the answer of `memoryPolicy` (`{ longTerm: 'compiled', retentionDays: 30 }`) shortens the period for that account in the sweeps of the process that asked; it never lengthens it.

Options for deletion:

- **`tombstoneKey`** is a secret from your secret store. With it the tombstones that record who was forgotten are keyed hashes (HMAC-SHA-256); without it they are plain SHA-256 hashes, which anyone who holds the store can match by hashing a guessed id. A store whose tombstones are keyed does not open without the key, and after a rotation pass `{ current, previous }`: the previous keys still check the old tombstones.
- **`tombstoneCopy`** is where the second copy of the tombstones lives: `{ path }` for a SQLite file, or `{ adapter }` for a database of your own (left open on `close()`). By default it is `memory/.store/forgotten.sqlite`. Keep it out of what a restore replaces: a store whose copy is missing or unreadable does not open.

Deleting a person:

- **`await agent.forgetUser(userId, { linkedSessions })`** waits for the person's pending writes (up to `pendingWritesTimeoutMs`), records a tombstone, deletes their traces, document chunks, pages and registry row for good, rewrites the vector index, empties the store's write-ahead log and returns a report: each store with `reached` and a count or a reason, `pages.failed`, `drained`, `pendingAtDeadline` and `complete`. Read the report: it names what the call does not reach (your own conversation history, a `gmi()` session's history, the learning store when the agent runs no learning layer, memory under the organization scope, and memory from before per-user scope). On the default runtime the history of the sessions the handle holds open for the person is cleared. `linkedSessions` names the anonymous sessions you have tied to the person: a user and a session of the same id are two subjects, and only the ones you name are deleted. The report never holds the id or any text, and neither does its `memory.forget_done` log line. A host that wires `attachMemoryWiki()` itself calls `forgetUserMemory()`.
- **Every open re-applies the tombstones:** it copies the ledger's second copy back into the store and deletes again whatever the store holds of a forgotten person, so a store restored from an older backup needs no special step, and a deletion that did not finish is finished. `await agent.applyTombstones()` runs the same step on demand and returns one report a subject deleted again; put it in your restore runbook, and on a schedule when several processes share one store on PostgreSQL (a second process learns of a tombstone at its next open or call). One `memory.tombstone_reapplied` log line counts the subjects deleted again and the tombstones that came back from the copy. Restore `memory.sqlite` from your backup and never `forgotten.sqlite` from an older one. Run one process per `souledAgent()` store on SQLite. A host that wires `attachMemoryWiki()` itself calls `reapplyTombstones()` after each open.

One `Memory` facade backs both the live memory and the wiki. The operator's pages are markdown files and the source of truth for themselves: their index entries in the store are rebuilt from them. Per-user traces and pages live in the store alone. `souledAgent()` accepts every `agent()` option and returns the same `Agent`, plus `agent.memory` (the store) when the soul resolves to a workspace directory. An inline soul (`{ content }`) has no workspace, so it falls back to a plain `agent()` and says so in one warning line. Closing the agent also closes the store. What applies on each way of loading a soul is tabled in [Soul Files](../SOUL_FILES.md#what-applies-on-each-path).

Runnable examples in the package source:

- [`examples/high-level-api.mjs`](https://github.com/framerslab/agentos/blob/master/examples/high-level-api.mjs)
- [`examples/generate-image.mjs`](https://github.com/framerslab/agentos/blob/master/examples/generate-image.mjs)
- [`examples/agentos-config-tools.mjs`](https://github.com/framerslab/agentos/blob/master/examples/agentos-config-tools.mjs)

## Full runtime: [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts)

```ts
import { AgentOS, AgentOSResponseChunkType } from '@framers/agentos';
import { createTestAgentOSConfig } from '@framers/agentos';

const agent = new AgentOS();
await agent.initialize(
  await createTestAgentOSConfig({
    tools: {
      open_profile: {
        description: 'Load a saved profile record by ID.',
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string' } },
          required: ['profileId'],
        },
        execute: async ({ profileId }) => ({
          success: true,
          output: { profile: { id: profileId, preferredTheme: 'solarized' } },
        }),
      },
    },
  })
);

for await (const chunk of agent.processRequest({
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'Explain how TCP handshakes work',
})) {
  if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
    process.stdout.write(chunk.textDelta);
  }
}
```

`AgentOSConfig.tools` accepts the same three forms as the high-level
helpers: named tool maps, [`ExternalToolRegistry`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/externalToolRegistry.ts) (`Record`, `Map`, or
iterable), and prompt-only `ToolDefinitionForLLM[]`. AgentOS normalizes those
inputs during `initialize(...)` and registers them into the shared
[`ToolOrchestrator`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ToolOrchestrator.ts), so direct `processRequest()` turns can plan against and
execute them without helper wrappers. If a config-registered tool collides with
an extension or pack tool name, the config tool wins at registration time.

If those external tool calls are AgentOS-registered tools, prefer
`processRequestWithRegisteredTools(...)`. It executes the registered tools with
the correct live-turn [`ToolExecutionContext`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) and resumes the stream for you:

```ts
import {
  AgentOS,
  AgentOSResponseChunkType,
  processRequestWithRegisteredTools,
} from '@framers/agentos';

const agent = await AgentOS.create();

for await (const chunk of processRequestWithRegisteredTools(agent, {
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'Search memory for my preferences',
})) {
  if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
    process.stdout.write(chunk.textDelta);
  }
}
```

If a live turn can mix AgentOS-registered tools with a stable host-managed tool
map, either configure `externalTools` once on `AgentOS.initialize(...)` or pass
`externalTools` to `processRequestWithRegisteredTools(...)`. It can be a
record, `Map`, or iterable of tool-like executors, and only missing tool names
will run through that host registry. Per-call `externalTools` override the
configured registry by tool name. Use `externalTools` for helper-level fallback
execution; use `AgentOSConfig.tools` when the tool should be permanently
registered and prompt-visible on direct runtime turns too.
If an `externalTools` entry also provides `description` and `inputSchema`, the
helper temporarily registers a proxy tool so the model can see and plan against
it during the turn. Execution-only entries without prompt metadata still work
for fallback execution, but they are not visible to the model up front.

If you need fully dynamic routing instead of a fixed tool map, keep using
`fallbackExternalToolHandler`.

For custom host-managed tools, keep using `processRequestWithExternalTools(...)`
and provide your own execution callback.

If you are building a lower-level/custom GMI path and only need prompt-visible
host tool schemas, configure `AgentOSConfig.externalTools` and call
`agent.listExternalToolsForLLM()`. That returns only the prompt-aware host
tools. You can turn those into raw OpenAI-style function schemas with
`formatToolDefinitionsForOpenAI(...)` or directly from the registry with
`formatExternalToolsForOpenAI(...)`.

`processRequestWithExternalTools(...)` is the simplest path while the same
AgentOS runtime stays alive. For restart-safe external tool execution, AgentOS
also persists actionable external pauses into the conversation metadata. A fresh
runtime can recover the pending request with
`getPendingExternalToolRequest(conversationId, userId)` and continue on a new
stream with `resumeExternalToolRequest(...)`:

If the pending tool calls are AgentOS-registered tools, prefer
`resumeExternalToolRequestWithRegisteredTools(...)`. It executes the registered
tools with the correct resume-time [`ToolExecutionContext`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) and then resumes the
stream for you.

```ts
import {
  AgentOS,
  AgentOSResponseChunkType,
  resumeExternalToolRequestWithRegisteredTools,
} from '@framers/agentos';

const agent = await AgentOS.create();
const pending = await agent.getPendingExternalToolRequest('conv-1', 'user-1');

if (pending) {
  for await (const chunk of resumeExternalToolRequestWithRegisteredTools(agent, pending, {
    organizationId: 'org-123',
  })) {
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
      process.stdout.write(chunk.textDelta);
    }
  }
}
```

If a persisted pause can mix AgentOS-registered tools with a stable
host-managed tool map, either configure `externalTools` once on
`AgentOS.initialize(...)` or pass `externalTools` to
`resumeExternalToolRequestWithRegisteredTools(...)`. The helper will execute
the registered tool calls itself and only delegate missing tool names to that
host registry before resuming the stream. Per-call `externalTools` override the
configured registry by tool name.
Prompt-aware entries with `description` and `inputSchema` are also registered
temporarily during the resumed stream so follow-up model calls can plan against
the same host tools.

If you need fully dynamic routing instead of a fixed tool map, keep using
`fallbackExternalToolHandler`.

For custom host-managed tools that are not registered in AgentOS, keep using
`resumeExternalToolRequest(...)` directly and supply your own tool results.

This recovery path assumes the conversation store is still available after the
original process exits.

A pause is resumed once. When the conversation no longer holds the pause the
snapshot names (its results were passed on its stream, an output guardrail
blocked its stream, a newer turn ended it, or a newer pause replaced it),
another resume of it is under way, or a result answers a call the pause does
not hold, `resumeExternalToolRequest(...)` yields one error chunk with the code
`SYS_INVALID_STATE` and the GMI takes none of the results. A resume ends the
stream the pause was saved on. The same rule holds on that stream:
`handleToolResult(...)` and `handleToolResults(...)` continue the pause once,
with results for its calls. A second delivery while the pause
is being continued, or a result for a call the stream's next pause does not
hold, yields one error chunk with the code `SYS_INVALID_STATE`; a result passed
after the stream closed (a resume took the pause, a newer turn ended it, or the
continuation finished) yields the closed stream's error chunk (`TOOL_ERROR`).
A resume refused for these reasons is refused before it acquires the session's
GMI, so it changes neither the conversation nor that GMI: the `preferredModelId` and
`preferredProviderId` a refused resume names are not recorded. Read the pending
request again with `getPendingExternalToolRequest(...)` before a retry.

Pass every result of a pause together: a call the results leave out is answered
with a tool result that says it has none (code `EXTERNAL_TOOL_NOT_RUN`), in the
conversation and in the results the GMI reads when it takes results together
(`IGMI.handleToolResults()`, as the shipped `GMI` does), and so is each call of
a pause a new turn ends, so the model never reads a call without its result. A
GMI that takes one result at a time reads the host's result alone.

A continuation that fails before the conversation records its results (the
store refuses to save that the pause was taken, or a result has no JSON form,
as an output holding a `BigInt` has none) yields an error chunk, ends its
stream and leaves the pause as it was: `getPendingExternalToolRequest(...)`
returns it, `resumeExternalToolRequest(...)` continues it, and a new turn ends
it. A resume whose `organizationId` the runtime refuses (a single-tenant
runtime with `strictOrganizationIsolation` and another organization) leaves the
pause as it was too, and so does a new turn the runtime refuses before it
records its input, for such an organization or because its turn plan fails.
A continuation that fails after the conversation recorded
its results keeps them, and a pause that a turn or a continuation saved before
it failed (the store refuses that save) ends the way a new turn ends one, since
the host never read its request.

The once-only rule holds within one AgentOS instance. Each instance keeps a
conversation in memory and saves it whole, so two instances that resume one
pause at the same time both resume it, and the later save overwrites the
earlier one. A deployment that runs several instances over one conversation
store sends each conversation's turns, tool results and resumes to one
instance at a time. Within one instance AgentOS does not queue a
conversation's operations either: a turn, a continuation and a resume each
start when the host calls them. Start a conversation's next turn once the
stream of its continuation or resume has ended: a turn that starts while one
runs finds no pause to end, and its input lands among the continuation's
messages.

`AgentOSConfig.learning` turns on the runtime's learning layer: every GMI sends its persona's personality section as a system prompt of its own on every turn, each session is bound to its user under the turn's resolved organization, and `AgentOS.getLearningLayer()` returns the layer (`undefined` while learning is off), which carries the operator's calls (`freeze`, `unfreeze`, `suspend`, `unsuspend`, `operatorSet`, `revert`, `exportLearnedState`, `importLearnedState` and `forgetUser`). [Learning](../GMI.md#learning) has the rules.

## Guidance

- Show high-level examples first in README and landing guides.
- Keep low-level [`AgentOS`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) examples in architecture, advanced usage, extensions, workflows, and runtime-control docs.
- Document both layers explicitly. They are complementary, not competing.
- Keep `generateImage()` provider-agnostic at the API boundary, but expose provider-specific knobs through `providerOptions` when needed.
- Do not force downstream libraries to adopt `agent()` unless the helper reaches feature parity with their runtime needs.
