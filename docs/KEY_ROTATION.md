# API Key Rotation

AgentOS runs several API keys per provider from one key string. Set the provider's API key environment variable (or the `apiKey` you pass) to a comma-separated list and the provider instance builds a key pool from it: a strategy picks the key for each request, a key-scoped failure takes a key out of rotation and moves the request to the next usable key, a probe brings a failed key back only when it works again, and a host can persist the keys' standing across restarts.

## Usage

```bash
# Single key:
ANTHROPIC_API_KEY=sk-ant-primary

# Several keys, round-robin (the default):
OPENAI_API_KEY=sk-key1,sk-key2

# Several keys in cost order: the first usable key is used until it fails.
# Credited keys first, the paid key last.
ANTHROPIC_API_KEY=sk-ant-credited-1,sk-ant-credited-2,sk-ant-paid
AGENTOS_KEY_POOL_STRATEGY=ordered
```

The same `apiKey` string works through the TypeScript API:

```ts
import { AnthropicProvider } from '@framers/agentos';

const provider = new AnthropicProvider();
await provider.initialize({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  keyPool: { strategy: 'ordered', recheckMs: 30 * 60_000 },
});
```

## How It Works

**Strategies.** `round-robin` (the default) is weighted: the first key fills two rotation slots and every other key one, so in a 3-key pool the selection frequency is 50% / 25% / 25%. `ordered` prefers the earliest usable key in the configured order, so a working key keeps being used until it fails. The strategy comes from the provider's `keyPool.strategy`, else from `AGENTOS_KEY_POOL_STRATEGY_<PROVIDER>` for that provider alone (`AGENTOS_KEY_POOL_STRATEGY_ANTHROPIC`, `_OPENAI`, `_GEMINI`, `_OPENROUTER`, `_REQUESTY`), else from `AGENTOS_KEY_POOL_STRATEGY` for every provider (`ordered` or `round-robin`), else round-robin; so a product can order its Anthropic keys and keep spreading load over its OpenAI keys. A single key is used as given, whatever the strategy.

**Failure kinds.** `classifyKeyFailure()` in [`quotaErrors.ts`](https://github.com/framerslab/agentos/blob/master/src/core/providers/quotaErrors.ts) names what an HTTP answer says about the key, by the status first and by the parsed error envelope second, never by a search of the raw body, so a request that was itself invalid never takes a working key out:

| Kind | The answers that mean it | What the pool does |
|---|---|---|
| `quota` | HTTP 429 (a throttle, a spent rate limit) and 456 | Rests the key for the Retry-After when the server sent one (bounded by `maxRetryAfterMs`, one hour; a Retry-After of zero counts as none), else for `cooldownMs` (15 minutes, not bounded), then puts it back. |
| `auth` | HTTP 401; a 403 whose envelope names the key (Anthropic's `authentication_error`, OpenAI's `invalid_api_key`, Requesty's "Invalid authorization token"); Google's HTTP 400 with reason `API_KEY_INVALID` | Takes the key out until a probe passes. |
| `billing` | HTTP 402; a 429 whose envelope says `insufficient_quota` (OpenAI); Anthropic's HTTP 400 "Your credit balance is too low"; Anthropic's spend limits: the HTTP 400 whose message begins "You have reached your specified API usage limits" (or "... specified workspace API usage limits") for a limit the operator set, and the HTTP 429 whose `error.details.error_code` is `enforced_spend_limit_reached` for the tier's monthly cap (no Retry-After, until the next month; [the rate limits page](https://platform.claude.com/docs/en/api/rate-limits), read 18 October 2026) | Takes the key out until a probe passes. |

Every other answer (a bad request, a missing model, a server error, a 403 `permission_error` or `insufficient_permissions` for a model, a feature or a region the key may not use) is the request's or the server's fault and leaves the key alone.

**Hops.** When a request's key fails in one of these kinds and the pool has another usable key, the provider takes the key out and re-sends the same request with the next usable key at once. A hop spends none of the provider's retry attempts (those still bound the 429 waits, the 5xx retries and the network retries), and a pool of N keys hops at most N-1 times for one request. When no key is usable but one is merely resting (a throttle), the request still goes out with the key whose rest ends soonest, after the provider's own Retry-After or backoff wait. When every key is out for `auth` or `billing`, the provider throws an error with code `ALL_KEYS_FAILED`, whose `details` carry the `kinds` seen and `retryAfterMs`, the soonest a key may come back; no such credential is sent again until a probe passes. Thrown before a request goes out, it carries the HTTP status of the kind that took the keys out (402 for `billing`, 401 for `auth`, 429 for `quota`), so the provider health breaker in front of `generateText()` treats a dead pool as it treats that answer; `generateText()`'s fallback log line names the error's `code` and the `kinds`. `generateText()` treats `ALL_KEYS_FAILED` like a provider outage and moves to the next provider in its order.

| Provider | Hops on a key failure | Streaming |
|---|---|---|
| Anthropic | Yes, inside the request | Hops before the first event reaches the caller; an in-stream error event that names the key marks it. |
| OpenAI (and Groq, Mistral, Together, xAI and LiteLLM, which send through an `OpenAIProvider`) | Yes, inside the attempt, so the attempt budget is untouched | Hops before the first event, as the same request path serves both. |
| Gemini | Yes, inside the request | A streaming request marks the key; the next request draws another. |
| OpenRouter | Yes, inside the request | The same. |
| Requesty | No: a single-shot request path marks the key, and the next request draws another | The same. |
| ElevenLabs TTS and SFX, Deepgram TTS, and the voice pipeline's batch TTS for OpenAI, ElevenLabs, Cartesia, Hume and Deepgram Aura | An error `isQuotaError()` recognizes rests the key, and the request is retried once on the next key | n/a |

Every other provider in the list below rotates its keys and never marks one.

`isQuotaError()` is the broad test those speech providers use: HTTP 429, 402 and 456, and response bodies that contain `quota_exceeded`, `rate_limit_exceeded`, `insufficient_quota`, `overloaded_error`, `resource_exhausted` or `rate_limit` (case-insensitive).

**Probes.** A key out for `auth` or `billing` is probed off the request path, first after `recheckMs` (30 minutes), then at double the delay on each failed probe up to `maxRecheckMs` (6 hours), with the probe bounded by `probeTimeoutMs` (10 seconds). The probe is the provider's lightest authenticated request: the models list for OpenAI, Anthropic (`GET /v1/models`), Gemini and Requesty, OpenRouter's `GET /auth/key`. A billing failure on Anthropic and OpenAI is probed with a one-token completion instead, since a models list can answer 200 with no credit left: on the provider's default model, else Anthropic's `claude-haiku-4-5-20251001` or the first chat model the OpenAI account lists (the reasoning families take `max_completion_tokens`); with no model to send, the probe reports unknown and the key stays out. A probe that passes re-admits the key; one that fails pushes the next probe out; one that times out or errors counts as unknown and does the same. A request's own answer after the probe began wins over the probe. Without a probe (a pool built directly from `new ApiKeyPool(keys)` with no `probe`), a failed key returns by time, when its recheck is due.

A pool's `startRechecks()` runs the probes on one interval per pool that never keeps the process alive. The five LLM providers start it once `initialize()` has succeeded, for a pool of several keys (a provider whose initialize fails runs none), and their `shutdown()` calls the pool's `close()`, which stops the interval, waits for the probes in flight (each bounded by the probe timeout) and writes the keys' standing, so what a probe found during shutdown is kept. The interval holds the pool weakly: a pool nothing else holds (a provider dropped without `shutdown()`, a manager evicted from `createProviderManager()`'s cache) ends its interval on the next tick. The pool also starts the due probes when a request draws a key, so a key comes back even while the provider health breaker holds the provider and no request reaches the pool.

**Persisted state.** With a `store` and an `id`, the pool saves each key's standing (status, kind, failures, timestamps; the key itself only as a 12-hex-character fingerprint and a label made of its index and its last four characters) a quarter of a second after it changes, and loads it in `initialize()` before the first request, so a restart does not send a revoked or unpaid key again. `SqlKeyPoolStateStore` in [`KeyPoolStateStore.ts`](https://github.com/framerslab/agentos/blob/master/src/core/providers/KeyPoolStateStore.ts) keeps it in one table (`<prefix>_key_pool_state`, DDL from `keyPoolStateDdl(prefix)`) through a `@framers/sql-storage-adapter` adapter, so the same code runs on SQLite, Postgres and the browser; `InMemoryKeyPoolStateStore` serves tests. A store that fails leaves a fresh state and logs one warning a minute. `flush()` writes the pending changes at once and waits for them; the providers' `shutdown()` calls it, so a host that shuts its providers down keeps the keys' standing.

```ts
import { createDatabase } from '@framers/sql-storage-adapter';
import { AnthropicProvider, SqlKeyPoolStateStore } from '@framers/agentos';

const db = await createDatabase({ filePath: './agentos.sqlite' });
// The store creates its table on first use; pass `ensureSchema: false` and run
// `keyPoolStateDdl('agentos')` in the host's migrations to own the schema.
const store = new SqlKeyPoolStateStore({ db, tablePrefix: 'agentos' });
const provider = new AnthropicProvider();
await provider.initialize({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  keyPool: { strategy: 'ordered', store, id: 'anthropic:main' },
});
```

**Logging.** The pool writes one line per state transition through the library's `key-pool` logger, never a key: `key_pool.key_failed` (with the kind, the HTTP status, the rest or the next probe time), `key_pool.all_keys_failed` (once, when the last usable key of a pool of several goes out; a single-key pool writes none), `key_pool.key_recovered` (by a success or by a probe), `key_pool.probe_failed`, `key_pool.state_saved`, `key_pool.state_loaded` and `key_pool.store_failed`. A repeat of the same event for the same key without a transition is written once per cooldown.

**Pools are per instance.** Two providers that read the same environment variable keep separate pools, so a key one of them takes out stays in the other's rotation until that instance sees the failure too; a shared `store` and `id` make them agree across restarts. `getKeyPool()` in `ApiKeyPoolRegistry.ts` returns one shared pool per environment variable; no built-in provider calls it.

**Health checks.** `checkHealth()` on the OpenAI, Anthropic, Gemini, OpenRouter and Requesty providers sends a key drawn from the pool, as a request does. Groq, Mistral, Together, xAI and LiteLLM pass their health check to an `OpenAIProvider`, so theirs draws from that instance's pool. An `OpenAIProvider` set up with an OAuth flow sends the flow's token, as its requests do; the pool never marks or hops a per-request override (even one equal to a pool key) or an OAuth token: those are the caller's choice.

## Products That Call `generateText()`

`generateText()`, `streamText()` and the completion gateway build their providers through `createProviderManager()` from the key in the environment (`ANTHROPIC_API_KEY` and the rest). Their pools take the strategy from the environment variables above, and a host that wants the keys' standing kept across restarts sets the defaults once at boot, before the first call:

```ts
import { createDatabase } from '@framers/sql-storage-adapter';
import { setKeyPoolDefaults, SqlKeyPoolStateStore } from '@framers/agentos';

const db = await createDatabase({ filePath: './agentos.sqlite' });
setKeyPoolDefaults({ strategy: 'ordered', store: new SqlKeyPoolStateStore({ db, tablePrefix: 'agentos' }) });
```

A key read from the environment names its pool `<provider>:<ENV_VAR>` (`anthropic:ANTHROPIC_API_KEY`), the id the store keeps its rows under; a key passed as an override or set with `setDefaultProvider()` names no pool, so the store does not apply to it. `createProviderManager()` caches one manager per provider, key, base URL, pool id and version of the defaults, so one key string from the environment and from an override builds two managers, and a call after `setKeyPoolDefaults()` builds a new manager with the new defaults; set them at boot so every pool shares the store from the first call. The module is also importable as `@framers/agentos/api/keyPoolDefaults`.

## Several Subscriptions, One Product

The case the pool is built for: an organization holds several Claude Max subscriptions, each with its own Console organization and monthly API credits, plus one paid organization. The product gets every credited key first and the paid key last, in order, so the credits are spent before a dollar is billed, and an exhausted key (Anthropic answers HTTP 400 "Your credit balance is too low") drops out until its probe passes:

```bash
ANTHROPIC_API_KEY=sk-ant-max-1,sk-ant-max-2,sk-ant-max-3,sk-ant-paid
AGENTOS_KEY_POOL_STRATEGY=ordered
```

## Supported Providers

- **LLM:** OpenAI, Anthropic, Gemini, OpenRouter and Requesty; Groq, Mistral, Together and xAI, each of which sends its requests through an `OpenAIProvider` instance and draws its key from that instance's pool
- **Speech TTS:** ElevenLabs, OpenAI TTS, Deepgram, MiniMax
- **Speech STT:** OpenAI Whisper, Deepgram, AssemblyAI
- **Voice Pipeline:** OpenAI batch TTS, Realtime TTS and Realtime transcription STT, ElevenLabs batch and streaming TTS and streaming STT, Cartesia batch and streaming TTS, Hume batch and streaming TTS, Deepgram Aura batch and streaming TTS and Deepgram streaming STT
- **Image:** OpenAI, Stability, Flux, Fal, Replicate, OpenRouter
- **Video:** Fal, Replicate, Runway
- **Audio:** ElevenLabs SFX, Suno, Udio, Stable Audio, Fal, Replicate
- **Segmentation:** Replicate
- **Web Search:** Serper, Tavily, Brave, Firecrawl

A provider that is not on this list sends the key it is configured with as given, so give it a single key. That covers Azure Speech (TTS and STT), DeepL and OpenAI translation, the voice pipeline's batch STT for OpenAI Whisper and for Deepgram, the MiniMax image provider and the Cohere reranker, among others. Give LiteLLM a single key too: its completions, streams, embeddings and health check draw a key from an `OpenAIProvider` pool, and its model listing sends the configured string as given.

## Implementation

The key pool is implemented in [`src/core/providers/`](https://github.com/framerslab/agentos/tree/master/src/core/providers):

- `ApiKeyPool.ts`: the strategies, `markFailed()` / `markSuccess()`, the probes and rechecks, the persisted state and the log lines; `keyPoolStrategyFromEnv()` reads `AGENTOS_KEY_POOL_STRATEGY`
- `KeyPoolStateStore.ts`: `KeyState`, `KeyPoolStateStore`, `InMemoryKeyPoolStateStore`, `SqlKeyPoolStateStore` and the table's DDL
- `quotaErrors.ts`: `classifyKeyFailure()` (the kinds above), `retryAfterMs()` (a Retry-After header as bounded milliseconds) and `isQuotaError()` (the broad rotation test)
- `ApiKeyPoolRegistry.ts`: one shared pool per environment variable (`getKeyPool()`), not used by the built-in providers

The first version's `markExhausted()` and `isQuotaError()` keep their behaviour, and the speech, image, video, audio and web-search providers keep rotating through them alone: their pools never hand out an empty key, since only `markFailed()` (the five LLM providers') takes a key out. What a caller of the first version sees differently, for the record: a 401, 402 or credit-balance 400 on one key of several moves the request to the next key instead of failing it; a 429 on one key of several moves at once and rests the key for its Retry-After (else the cooldown) instead of always the cooldown; `AGENTOS_KEY_POOL_STRATEGY` and the per-provider variables change the strategy of a pool whose config names none; once every key is out the error's code is `ALL_KEYS_FAILED` where `API_CLIENT_ERROR`, `RATE_LIMIT_EXCEEDED` or `API_REQUEST_FAILED` came before; a key list given as an array is trimmed and deduplicated as a string list always was; and the LLM providers probe their failed keys on an interval.
