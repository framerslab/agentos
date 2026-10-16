# Speech Provider Ecosystem

This document describes the provider resolver system in `src/io/speech/`, which auto-discovers and manages speech-to-text (STT), text-to-speech (TTS), voice activity detection (VAD), and wake-word providers.

---

## Overview

[`SpeechProviderResolver`](https://github.com/framerslab/agentos/blob/master/src/io/speech/SpeechProviderResolver.ts) is the central registry for speech providers. It:

- Registers **core providers** from a static catalog at startup based on present environment variables.
- Discovers **extension providers** from an optional [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts) (priority 200, lower than core).
- Resolves the best provider for a given kind, respecting streaming/local/feature requirements.
- Optionally wraps multiple candidates in a **fallback proxy** that automatically tries the next provider when one fails.
- Emits events (`provider_registered`, `provider_fallback`) for observability.

---

## Quick Start

Set the environment variables for the providers you want, then build a `SpeechRuntime` and call `refresh()` on its resolver:

```typescript
import { SpeechRuntime } from '@framers/agentos/speech';

// Builds, and registers in its resolver: OpenAI Whisper and OpenAI TTS when
// OPENAI_API_KEY is set, ElevenLabs when ELEVENLABS_API_KEY is set, Deepgram batch
// STT and Deepgram Aura TTS when DEEPGRAM_API_KEY is set, AssemblyAI when
// ASSEMBLYAI_API_KEY is set, Azure Speech STT and TTS when AZURE_SPEECH_KEY and
// AZURE_SPEECH_REGION are set, and AgentOS Adaptive VAD.
const runtime = new SpeechRuntime({ env: process.env });
// Records the other core ids. Pass an ExtensionManager to add the speech
// providers its packs registered: runtime.resolver.refresh(extensionManager).
await runtime.resolver.refresh();

const stt = runtime.resolver.resolveSTT();   // best configured STT provider
const tts = runtime.resolver.resolveTTS();   // best configured TTS provider
const vad = runtime.resolver.resolveVAD();   // AgentOS Adaptive VAD
const wakeWord = runtime.resolver.resolveWakeWord(); // null if none configured
```

`refresh()` records every core provider id and whether its keys are set, and keeps any provider instance already registered under that id. The resolve methods return only providers that have an instance: the ones `SpeechRuntime` builds, the ones you pass to `register()`, and the ones an extension manager supplies. A `SpeechProviderResolver` used on its own throws `No configured STT provider matches requirements` (or the TTS or VAD equivalent) until a provider instance is registered.

---

## Configuration via `agent.config.json`

Add a `speech` section to your agent configuration to control provider preference order and fallback behavior:

```json
{
  "speech": {
    "stt": {
      "preferred": ["assemblyai", "deepgram-batch", "openai-whisper"],
      "fallback": true
    },
    "tts": {
      "preferred": ["elevenlabs", "openai-tts"],
      "fallback": true
    }
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `stt.preferred` | `string[]` | Provider ids in priority order. Overrides the default catalog priority. |
| `stt.fallback` | `boolean` | When `true`, wraps multiple candidates in a [`FallbackSTTProxy`](https://github.com/framerslab/agentos/blob/master/src/io/speech/FallbackProxy.ts). |
| `tts.preferred` | `string[]` | Provider ids in priority order for TTS. |
| `tts.fallback` | `boolean` | When `true`, wraps multiple candidates in a [`FallbackTTSProxy`](https://github.com/framerslab/agentos/blob/master/src/io/speech/FallbackProxy.ts). |

Preferred providers receive priorities 50, 51, 52, … (lower number = higher priority). All other core providers default to priority 100 and extension providers default to 200.

---

## Provider Table

### Speech-to-Text (STT)

| ID | Label | Env Vars | Local | Streaming | Features |
|---|---|---|---|---|---|
| `openai-whisper` | OpenAI Whisper | `OPENAI_API_KEY` | No | No | cloud, timestamps, transcription |
| `deepgram-batch` | Deepgram Batch | `DEEPGRAM_API_KEY` | No | No | cloud, diarization, timestamps |
| `deepgram` | Deepgram | `DEEPGRAM_API_KEY` | No | Yes | cloud, streaming |
| `deepgram-streaming` | Deepgram Streaming | `DEEPGRAM_API_KEY` | No | Yes | streaming, interim-results, diarization, punctuation, endpointing |
| `assemblyai` | AssemblyAI | `ASSEMBLYAI_API_KEY` | No | Yes | cloud, streaming, diarization |
| `google-cloud-stt` | Google Cloud STT | `GOOGLE_STT_CREDENTIALS` | No | No | batch transcription through the installed provider |
| `azure-speech-stt` | Azure Speech STT | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | No | No | cloud, streaming |
| `whisper-chunked` | Whisper Chunked Streaming | `OPENAI_API_KEY` | No | Chunked | a stream-shaped adapter over bounded file requests, not an intrinsically streaming acoustic model |
| `openai-realtime-transcription` | OpenAI Realtime Transcription | `OPENAI_API_KEY` | No | Yes | streaming, interim-results, endpointing, item-ids, long-sessions |
| `whisper-local` | Whisper.cpp | — | Yes | No | local, offline _(unavailable: no implementation)_ |
| `vosk` | Vosk | none | Yes | No | local, offline, batch provider |
| `moonshine-browser` | Moonshine (in the browser) | — | Yes | Yes | local, offline, streaming, browser |
| `nvidia-nemo` | NVIDIA NeMo | — | Yes | No | local, offline _(unavailable — not yet integrated)_ |

`moonshine-browser` is a streaming provider for a browser page or worker on the user's own device; [Speech-to-text in the browser](./VOICE_PIPELINE.md#speech-to-text-in-the-browser) shows it. An entry marked unavailable stays in the catalogue, so a lookup by its id finds it, and `isSpeechProviderConfigured()` reports it as not configured.

### Text-to-Speech (TTS)

| ID | Label | Env Vars | Local | Streaming | Features |
|---|---|---|---|---|---|
| `openai-tts` | OpenAI TTS | `OPENAI_API_KEY` | No | Yes | cloud, tts |
| `openai-streaming-tts` | OpenAI Streaming TTS | `OPENAI_API_KEY` | No | Yes | streaming, sentence-chunking |
| `elevenlabs` | ElevenLabs | `ELEVENLABS_API_KEY` | No | Yes | cloud, tts, voice-cloning |
| `elevenlabs-streaming-tts` | ElevenLabs Streaming TTS | `ELEVENLABS_API_KEY` | No | Yes | streaming, websocket, continuation-hints |
| `deepgram-aura` | Deepgram Aura | `DEEPGRAM_API_KEY` | No | Yes | catalog entry; runtime construction requires a configured provider |
| `minimax-tts` | MiniMax TTS | `MINIMAX_API_KEY` | No | Yes | catalog entry; runtime construction requires a configured provider |
| `google-cloud-tts` | Google Cloud TTS | `GOOGLE_TTS_CREDENTIALS` | No | No | cloud, tts |
| `amazon-polly` | Amazon Polly | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | No | Yes | cloud, tts |
| `azure-speech-tts` | Azure Speech TTS | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | No | Yes | cloud, tts |
| `piper` | Piper | — | Yes | No | local, offline, tts |
| `coqui` | Coqui XTTS | — | Yes | Yes | local, tts, voice-cloning _(unavailable — not yet integrated)_ |
| `bark` | Bark | — | Yes | No | local, tts _(unavailable — not yet integrated)_ |
| `styletts2` | StyleTTS2 | — | Yes | No | local, tts _(unavailable — not yet integrated)_ |

### VAD

| ID | Label | Env Vars | Local | Features |
|---|---|---|---|---|
| `agentos-adaptive-vad` | AgentOS Adaptive VAD | — | Yes | local, vad, adaptive |

### Wake-Word

| ID | Label | Env Vars | Local | Features |
|---|---|---|---|---|
| `porcupine` | Porcupine | `PICOVOICE_ACCESS_KEY` | Yes | local, wake-word |
| `openwakeword` | OpenWakeWord | — | Yes | local, wake-word |

### Telephony

| ID | Label | Env Vars | Extension |
|---|---|---|---|
| `twilio` | Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `voice-twilio` |
| `telnyx` | Telnyx | `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID` | `voice-telnyx` |
| `plivo` | Plivo | `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN` | `voice-plivo` |

---

## Scoped provider resolution

Batch capability is not a streaming session. The tables describe catalog entries and installed interfaces, not every capability a vendor sells. A catalog id does not instantiate a provider; `whisper-local` has no built-in runtime instance. The Vosk and Google Cloud STT packs expose batch recognition. Their batch results cannot satisfy `startSession` merely by setting a streaming flag.

`resolveVoicePlan` is the scoped call entry on the same `SpeechProviderResolver`. It reads typed factories, validates model/voice revisions, language, sample rate, codec and closed options, then freezes the call selection. `resolveScopedBatch` retains batch operation as an explicit separate choice. `ExtensionManager.getVoiceAdapters()` discovers scoped factories without opening them or resolving a process credential.

The configured call policy names its mode and fallback allowlist. Hosted construction rejects legacy environment discovery and never treats the presence of an environment key as permission to contact another vendor. Every actual request and retry passes through `VoiceAdapterRuntime` and its attempt authorizer. Legacy `SpeechRuntime` and the environment constructors remain single-tenant conveniences with their existing behavior.

Provider retirement data lives in `src/io/speech/retirements.ts`, and its dated tests in `src/io/speech/__tests__/retirements.test.ts`. Consult that versioned register and its source notices before selecting a model. A replacement model name does not prove protocol compatibility with an existing adapter. The hosted factory does not silently substitute a retiring provider.

---

## Fallback Behavior

When `fallback: true` is set for an STT or TTS kind, `resolveSTT()` / `resolveTTS()` returns a proxy wrapping all configured candidates sorted by priority. On each call:

1. The proxy invokes the first provider.
2. If it throws or rejects, the proxy emits a `provider_fallback` event on the resolver with `{ from, to, error }`.
3. The next provider in the chain is tried.
4. If all providers fail, the original error from the first provider is re-thrown.

This lets you configure `OPENAI_API_KEY` and `DEEPGRAM_API_KEY` together with `fallback: true` and never worry about a single provider outage disrupting voice sessions.

```typescript
resolver.on('provider_fallback', ({ from, to, error }) => {
  console.warn(`STT fallback: ${from} → ${to} (${error.message})`);
});
```

---

## A speech-to-text chain from entries

`createSttChain(entries, options)` in [`env-constructor.ts`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/env-constructor.ts) builds the voice pipeline's [`StreamingSTTChain`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/StreamingSTTChain.ts) from a list the host chooses, such as a setting per audience, where `createVoiceProvidersFromEnv()` and `createSttChainFromEnv()` build it from the environment's keys in a fixed order:

```typescript
import { createSttChain, sttEntryPricePerMinute } from '@framers/agentos/io/voice-pipeline';

const apiKey = process.env.OPENAI_API_KEY!;
const stt = createSttChain(['openai:gpt-4o-transcribe', 'openai:gpt-4o-mini-transcribe'], { openai: { apiKey } });
const session = await stt.startSession({ language: 'en' });

sttEntryPricePerMinute('openai:gpt-4o-transcribe'); // 0.006 US dollars a minute
sttEntryPricePerMinute('deepgram:nova-3'); // 0.0077 US dollars a minute
sttEntryPricePerMinute('elevenlabs:scribe_v2'); // undefined: no price row
```

**The entry.** An entry has the form `vendor:model`: a vendor of `STT_CHAIN_VENDORS` (`openai`, `deepgram`, `elevenlabs`), a colon, and the model's name, 1 to 128 letters, digits, `.`, `_` and `-`. The original `STT_CHAIN_VENDORS` remain the built-in convenience choices. `parseSttEntry(entry)` returns `{ vendor, model }` and throws a `RangeError` for any other shape, a vendor outside the list included. Registered entry support is explicit; a settings string alone does not install a model or grant credentials. `parseSttEntry(entry, registeredVendors)` reads the vendors a host registered instead, and no other, a built-in one included: a vendor there is a lower-case letter followed by up to 63 lower-case letters, digits or `-`, such as `local-stt`, and the result is a `RegisteredSttEntry`. Neither form puts the entry in its error message. Its module imports nothing, so the browser entry, `@framers/agentos/io/voice-pipeline/browser`, exports it as well, and a page can hold a list of entries to the rule the server builds them by. The scoped factory uses typed registrations and its frozen policy, not ambient environment discovery.

**The order is the priority.** The entries take the priorities 10, 20, 30 and so on, in the order given: a session starts on the first provider whose session opens, and the next entry is its fallback. `createSttChain` throws a `RangeError` for an empty list, an entry named twice, an entry `parseSttEntry` refuses, or an entry whose vendor has no options. Mid-utterance failover is off unless the third argument, the chain's `StreamingSTTChainOptions`, turns it on, so a session is the provider's own, with its `flush()` and its events; with failover on, a session is the chain's facade, which forwards transcripts, speech events, `'usage'` and `'warning'`, and whose `flush()` drains the provider session in use.

**The vendors and their options.** Each vendor's options are its provider's configuration without `model` and `priority`, its API key among them: the entry names the model, and its place in the list sets the priority. Every entry of one vendor shares that vendor's options and its provider id (every `openai` entry is `openai-realtime-transcription`), so `currentProviderId` cannot tell two entries of one vendor apart. The chain's provider events and a `CircuitBreaker` in the chain options name each entry by that id and its place among the vendor's entries (`openai-realtime-transcription#2`): a breaker counts each entry's failures, and skips only the entries it has tripped. [VOICE_PIPELINE.md](./VOICE_PIPELINE.md#openai-realtime-transcription) describes the OpenAI provider and its options.

**Ending a stream.** If the provider closes after a facade `flush()` and before the next audio frame, the facade emits `close` once, releases its active session and starts no backup. Further `pushAudio()` and `flush()` calls are ignored, as after the caller's `close()`; a new stream needs a new session. `currentProviderId` retains the last selected provider's id. In a [listen session](./VOICE_PIPELINE.md#listening-without-speaking), stopping flushes STT, waits for late finals and then allows a pending endpoint-detector turn to complete within its configured silence bound before resetting. Purging skips both drains. A transport error ends listening with `transport_failed` and the error in `ended.error`; cleanup releases any outstanding transport pause and removes the session's transport listeners.

| Vendor | Provider | Options |
|---|---|---|
| `openai` | [`OpenAIRealtimeTranscriptionSTT`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/OpenAIRealtimeTranscriptionSTT.ts) | `options.openai` |
| `deepgram` | [`DeepgramStreamingSTT`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/DeepgramStreamingSTT.ts) | `options.deepgram` |
| `elevenlabs` | [`ElevenLabsStreamingSTT`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/ElevenLabsStreamingSTT.ts) | `options.elevenlabs` |

**Registered vendors.** `createRegisteredSttChain(entries, registry, options)`, beside `createSttChain` in `env-constructor.ts`, builds the chain from entries of vendors the host registers, through the host's own factories, and reads no environment:

```typescript
import { createRegisteredSttChain } from '@framers/agentos/io/voice-pipeline/env-constructor';

const registry = new Map([['local-stt', (model: string, priority: number) => localSttProvider(model, priority)]]);
const stt = createRegisteredSttChain(['local-stt:base-en'], registry, { policy });
```

Each entry's vendor must be a key of the registry. Its factory receives the model and the entry's priority (10, 20, 30 and so on, in the order given) and returns the provider, which holds what it needs, its credential among them, and does no work until a session opens. The third argument is the chain's `StreamingSTTChainOptions`, so a `ProviderPolicy` there decides which providers open and in what order ([Provider policy](./VOICE_PIPELINE.md#provider-policy)): the chain keeps only the provider ids the policy selects, and each must come from exactly one entry, so a factory gives each model a provider id of its own when two entries of one vendor are permitted. `createRegisteredSttChain` throws a `RangeError` for an empty list, an entry named twice, or an entry `parseSttEntry` refuses for the registry's vendors.

**Prices.** `sttEntryPricePerMinute(entry)` gives the US dollars a minute of an entry's audio from the providers' price rows, and `undefined` for an entry with no row; ElevenLabs entries have none. Like `createSttChain`, it throws a `RangeError` for an entry `parseSttEntry` refuses, such as `device:moonshine-auto` (a vendor outside `STT_CHAIN_VENDORS`) or `openai` (no model). OpenAI's rows are `OPENAI_TRANSCRIPTION_PRICING` in [`openaiPricing.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/openaiPricing.ts), from [OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) as read on 8 October 2026:

| Model | US dollars a minute |
|---|---|
| `gpt-4o-mini-transcribe` | 0.003 |
| `gpt-4o-transcribe` | 0.006 |
| `gpt-transcribe` | 0.0045 |
| `gpt-live-transcribe` | 0.017 |
| `gpt-realtime-whisper` | 0.017 |

A dated snapshot without a row of its own (the model's name followed by `-YYYY-MM-DD`) takes its base model's price.

Deepgram's rows are `DEEPGRAM_STREAMING_PRICING` and `DEEPGRAM_PRE_RECORDED_PRICING` in [`deepgramPricing.ts`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/deepgramPricing.ts): the pay-as-you-go price a minute of audio that [Deepgram's pricing page](https://deepgram.com/pricing) lists, as read on 15 October 2026, in one table for streamed audio and one for pre-recorded audio, which Deepgram prices separately. The page shows a lower current price for streamed audio for a limited time beside the regular price; the streaming row holds the regular price, so a spending bound read from it still holds when the offer ends. A row is the price of a request with no add-on: Deepgram bills its add-ons a minute on top of it, at the rates its pricing page lists beside the model, and `DeepgramStreamingSTT` turns two of them on from `providerOptions` (`diarize` sends `diarize=true`; `keywords` sends `keyterm` on Nova-3 and `keywords` on older models), so a bound read from a row covers a request only while it turns on no add-on, and a consumer that turns one on prices that add-on as well:

| Model | Audio | US dollars a minute |
|---|---|---|
| `nova-3` | Streamed | 0.0077 |
| `nova-3` | Pre-recorded | 0.0043 |

The rows are the prices of Nova-3 Monolingual. Deepgram's pricing page lists Nova-3 Multilingual higher, and a `nova-3` session started with `language: 'multi'` transcribes several languages ([multilingual code switching](https://developers.deepgram.com/docs/multilingual-code-switching)): a host that runs a Deepgram entry that way prices it from Deepgram's page, not from a row. Any other Deepgram model, `nova-2` among them, has no row. `sttEntryPricePerMinute('deepgram:nova-3')` reads the streaming row. The pre-recorded row prices a batch request, such as one [`DeepgramPreRecordedBatchSTT`](https://github.com/framerslab/agentos/blob/master/src/io/voice-pipeline/providers/DeepgramPreRecordedBatchSTT.ts) sends, and never a streamed session. `deepgramStreamingPricing(model)` and `deepgramPreRecordedPricing(model)` read only their own table's rows, so a model named after a property every object inherits, such as `constructor`, has none, and both tables are frozen. `DEEPGRAM_STREAMING_PRICING`, `DEEPGRAM_PRE_RECORDED_PRICING`, `deepgramStreamingPricing` and `deepgramPreRecordedPricing` are exported from `@framers/agentos/io/voice-pipeline`, from `@framers/agentos/safety/runtime` and from `@framers/agentos`.

Neither table establishes the price of a request sent with `mip_opt_out=true`, which `DeepgramStreamingSTT` and `DeepgramPreRecordedBatchSTT` send when their `mipOptOut` option is set, and a streaming session also sends when its `providerOptions.mip_opt_out` is `true`. Deepgram's API reference asks callers to check the pricing impact of opting out of its [Model Improvement Program](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program) before sending it, and neither the programme's page nor the pricing page, as read on 15 October 2026, states the price of an opted-out request. A host that opts out verifies its account's tariff for those requests before it bounds their spend with a row.

---

## Resolution Requirements

Both `resolveSTT()` and `resolveTTS()` accept an optional [`ProviderRequirements`](https://github.com/framerslab/agentos/blob/master/src/io/speech/types.ts) object:

```typescript
interface ProviderRequirements {
  /** Only match providers whose catalog entry declares streaming === true/false. */
  streaming?: boolean;
  /** Only match providers whose catalog entry declares local === true/false. */
  local?: boolean;
  /** Only match providers that declare all listed features. 'streaming' here means the streaming capability above. */
  features?: string[];
  /** Return only these provider ids, in this order. */
  preferredIds?: string[];
}
```

Example — require a streaming, cloud-based STT provider:

```typescript
const stt = resolver.resolveSTT({ streaming: true, local: false });
```

If no configured provider matches the requirements, `resolveSTT()` / `resolveTTS()` throw with an error message describing the mismatch.

---

## Installing Extension Providers

Extension providers ship as npm packages under the `@framers/agentos-ext-*` namespace and expose their provider implementation via an [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts). Install the package, load it into an [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts), and pass the manager to `refresh()`:

```bash
npm install @framers/agentos-ext-google-cloud-tts
```

```typescript
import { ExtensionManager } from '@framers/agentos/extensions';
import { SpeechRuntime } from '@framers/agentos/speech';

// The Google Cloud TTS pack reads its credentials as the GOOGLE_CLOUD_TTS_CREDENTIALS
// secret; GOOGLE_TTS_CREDENTIALS is the variable the provider table above names.
const em = new ExtensionManager({
  secrets: { GOOGLE_CLOUD_TTS_CREDENTIALS: process.env.GOOGLE_TTS_CREDENTIALS ?? '' },
});
await em.loadPackFromPackage('@framers/agentos-ext-google-cloud-tts');

const runtime = new SpeechRuntime({ env: process.env });
await runtime.resolver.refresh(em);

// The pack's provider resolves under its own id, beside the ones SpeechRuntime built.
const tts = runtime.resolver.resolveTTS({ preferredIds: ['google-cloud-tts'] });
```

A later `refresh(em)` drops a provider the manager no longer lists as active, such as one from an unloaded pack.

Extension providers default to priority 200. Add them to `tts.preferred` to promote them above core providers.

---

## Adding a Custom Provider

### 1. Implement the interface

```typescript
import type { SpeechToTextProvider, TranscribeInput, TranscribeResult } from '@framers/agentos/speech';

export class MyCustomSTT implements SpeechToTextProvider {
  readonly id = 'my-custom-stt';
  readonly supportsStreaming = false;

  getProviderName(): string { return 'my-company'; }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    // Call your API here
    return { text: '...', cost: 0 };
  }
}
```

For TTS implement [`TextToSpeechProvider`](https://github.com/framerslab/agentos/blob/master/src/io/speech/types.ts); for VAD implement [`SpeechVadProvider`](https://github.com/framerslab/agentos/blob/master/src/io/speech/types.ts); for wake-word implement [`WakeWordProvider`](https://github.com/framerslab/agentos/blob/master/src/io/speech/types.ts).

### 2. Register it directly

```typescript
import { findSpeechProviderCatalogEntry } from '@framers/agentos/speech';

resolver.register({
  id: 'my-custom-stt',
  kind: 'stt',
  provider: new MyCustomSTT(),
  catalogEntry: {
    id: 'my-custom-stt',
    kind: 'stt',
    label: 'My Custom STT',
    envVars: ['MY_STT_API_KEY'],
    local: false,
    description: 'Custom STT via internal API',
    features: ['cloud'],
  },
  isConfigured: Boolean(process.env.MY_STT_API_KEY),
  priority: 50,  // set low to prefer over core providers
  source: 'core',
});
```

### 3. Or expose via an ExtensionPack

Bundle your provider inside an extension pack and publish it so others can install it via `npm install`:

```typescript
// my-stt-extension/index.ts
export function createExtensionPack(): ExtensionPack {
  return {
    descriptors: [
      {
        id: 'my-custom-stt',
        kind: 'stt-provider',
        payload: new MyCustomSTT(),
      },
    ],
  };
}
```

See [RFC_EXTENSION_STANDARDS.md](../extensions/RFC_EXTENSION_STANDARDS.md) for the full extension pack specification.

---

## Cutting a Recording in the Browser

Install the optional peer `mediabunny` alongside AgentOS to use `@framers/agentos/io/hearing/pieces`. This entry accepts a `Blob` or `Uint8Array`, reaches no Node built-in and also re-exports `transcribePieces` and its types.

```typescript
import { readAudioInfo, cutPieces } from '@framers/agentos/io/hearing/pieces';

// `file` is the Blob selected by the caller.
const info = await readAudioInfo(file);
if (info.path === null) throw new Error(`Cannot read this recording: ${info.reason}`);

for await (const piece of cutPieces(file, {
  pieceSeconds: 300,
  overlapSeconds: 3,
  maxBytes: 24_000_000,
})) {
  // Each piece has index, startMs, durationMs, data, mimeType and fileName.
  // Pass it to the caller's transcription transport, or feed the iterable to transcribePieces.
  console.log(piece.fileName, piece.startMs, piece.durationMs);
}
```

`readAudioInfo` reports the container, codec, seconds, sample rate, channels and a `copy`, `decode` or refused (`null`) path. AAC is copied into M4A, Opus and Vorbis into WebM, MP3 into MP3, and little-endian 16-bit PCM at at most 64,000 bytes per second into WAV. Compressed tracks are read packet by packet to measure their average byte rate; above the same limit they require decoding. Other PCM and decodable codecs are converted to 16 kHz mono 16-bit WAV. Unknown codecs, AC-3, E-AC-3 and DTS are refused; a codec that needs an unavailable decoder reports `cannot_decode`. Unrecognized containers throw `UnreadableAudioError` with reason `container`.

`planPieces(seconds, { pieceSeconds, overlapSeconds })` gives nominal starts and ends without reading audio. A piece must be at least ten seconds, and a trailing remainder no longer than the overlap plus one second joins the previous piece. For example, 1,000 seconds with 300-second pieces and three seconds of overlap gives starts at 0, 297, 594 and 891 seconds.

On the decode path, `cutPieces` searches the ten seconds before each interior mark for the quietest 100 ms of the first channel. `quietSeconds` changes that window. If the search fails to decode or contains no complete frame, the planned mark is kept. The copy path never decodes for this search. The next piece starts `overlapSeconds` before the chosen end, while later end marks retain their nominal positions. `fromIndex` skips yielding earlier pieces while still computing their boundaries. The caller's `signal` is checked before each piece, and a piece larger than `maxBytes` is refused with `RangeError`. Copied boundaries follow encoded packets, so their container durations may differ from the reported boundaries by a packet.

On a server, `pieceSeconds(bytes)` reads the container duration without a decoder. `wavHeaderSeconds(bytes)` reads the WAV byte rate and declared data length and accepts a header without its sample payload. `readWavPcm(bytes)` reads a complete WAV as `{ sampleRate, channels, samples }`, with one `Float32Array` per channel. It supports 16-bit integer PCM and 32-bit float PCM and refuses other WAVE encodings with `UnreadableAudioError` (`unsupported_codec`). It reverses `encodeFloat32ToWav` from `@framers/agentos/io/speech`; multi-channel samples must be interleaved again before that encoder is called.

## Transcribing a Long Recording in Pieces

A recording too long for one transcription request is sent in pieces. When the pieces overlap by a few seconds, the words of each overlap come back twice: at the end of one piece's text and at the start of the next. `transcribePieces` (in `@framers/agentos/io/hearing`) sends the pieces to a function you give it and joins their texts without the repeated words:

```typescript
import { OpenAIWhisperSpeechToTextProvider, transcribePieces } from '@framers/agentos/io/hearing';

const provider = new OpenAIWhisperSpeechToTextProvider({ apiKey: process.env.OPENAI_API_KEY! });

// One span per sentence. The last sentence of a piece's text is the next piece's prompt.
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const sentences = (text: string) =>
  [...segmenter.segment(text)].map(({ index, segment }) => ({ start: index, end: index + segment.length }));

// `pieces`: the recording's pieces in order, each { index, startMs, durationMs, data, mimeType, fileName }.
const { text, seconds } = await transcribePieces(
  pieces,
  async (piece, { prompt }) => {
    const answer = await provider.transcribe(
      { data: Buffer.from(piece.data), mimeType: piece.mimeType, fileName: piece.fileName },
      { prompt },
    );
    return { text: answer.text, seconds: answer.durationSeconds ?? piece.durationMs / 1000 };
  },
  { sentences, inFlight: 2, onPiece: (outcome) => console.log(outcome.index, outcome.added) },
);
```

The job answers `text` (the joined text), `pieces` (each piece's outcome, in order) and `seconds` (the sum of the seconds your function answered for the pieces).

- **Order.** The pieces go to your function in the order given, at most `inFlight` at once (1 unless set, 4 at most). `onPiece` is called with each piece's outcome in that order, once the piece and every piece before it are done, even while the source is preparing its next piece. Each callback finishes before the next starts; `outcome.added` is what the piece added to the text after its seam.
- **Context.** Before every attempt, including retries, a call's `prompt` is the last sentence, by your `sentences` function, of the newest earlier piece of the recording that has finished transcription. Completed later pieces never supply a retry's context. If no earlier piece has answered, the prompt comes from `previousText` when set; otherwise there is no prompt.
- **Retries.** A call that throws is made again, up to `attempts` tries for a piece in all (3 unless set). When a piece fails every try, the job rejects with `PiecesFailed`, which carries the piece's `index`, its `attempts` and the last error as `cause`. The pieces before it have been reported to `onPiece` by then; no piece after it is reported, even one that was transcribed.
- **Limits.** Non-finite `attempts` or `inFlight` values, including `NaN` and infinities, use their defaults of 3 and 1 respectively. Finite values retain the minimum of 1 and the maximum of 4 for `inFlight`.
- **Going on.** To go on after a failure, call `transcribePieces` with the pieces from the failed one on and `previousText` set to the text so far: every `outcome.added` that is not empty, joined by one space. The first of those pieces is joined to that text at its seam and takes its prompt from it, and the answer's `text` begins with it.
- **Stopping.** An aborted `signal` interrupts a pending source read: no further try is made, and the job rejects with the signal's reason after transcription calls in flight settle. Your function is given the same signal as `request.signal`. If the source or `onPiece` throws, the job also stops sending pieces and retrying, waits for calls in flight, and rejects with that original error. On an early exit, the source's `return()` is called when present; cleanup does not wait for it, since it can be blocked behind a pending read.

The join is `mergeSeam(previous, next)`, exported beside the job. It drops from the start of `next` the longest run of 2 to 20 words that also ends `previous`. Words are compared in lower case with the marks `. , ! ? ; : " ' ( ) [ ] { }` removed (`normalizeTranscriptText`, exported from `@framers/agentos/io/voice-pipeline`). The run may begin at the first, second or third word of `next`, since a cut can leave part of a word at the start of a piece, and the one or two words before the run are dropped with it. With no such run, `next` is kept whole.

---

## Related Documentation

- [VOICE_PIPELINE.md](./VOICE_PIPELINE.md) — end-to-end voice session orchestration
- [RFC_EXTENSION_STANDARDS.md](../extensions/RFC_EXTENSION_STANDARDS.md) — extension pack authoring guide
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — high-level package architecture
