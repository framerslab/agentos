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
| `google-cloud-stt` | Google Cloud STT | `GOOGLE_STT_CREDENTIALS` | No | Yes | cloud, streaming |
| `azure-speech-stt` | Azure Speech STT | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | No | No | cloud, streaming |
| `whisper-chunked` | Whisper Chunked Streaming | `OPENAI_API_KEY` | No | Yes | streaming, interim-results |
| `whisper-local` | Whisper.cpp | — | Yes | No | local, offline |
| `vosk` | Vosk | — | Yes | Yes | local, offline, streaming |
| `nvidia-nemo` | NVIDIA NeMo | — | Yes | No | local, offline _(unavailable — not yet integrated)_ |

### Text-to-Speech (TTS)

| ID | Label | Env Vars | Local | Streaming | Features |
|---|---|---|---|---|---|
| `openai-tts` | OpenAI TTS | `OPENAI_API_KEY` | No | Yes | cloud, tts |
| `openai-streaming-tts` | OpenAI Streaming TTS | `OPENAI_API_KEY` | No | Yes | streaming, sentence-chunking |
| `elevenlabs` | ElevenLabs | `ELEVENLABS_API_KEY` | No | Yes | cloud, tts, voice-cloning |
| `elevenlabs-streaming-tts` | ElevenLabs Streaming TTS | `ELEVENLABS_API_KEY` | No | Yes | streaming, websocket, continuation-hints |
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

- **Order.** The pieces go to your function in the order given, at most `inFlight` at once (1 unless set, 4 at most). `onPiece` is called with each piece's outcome in that order, once the piece and every piece before it are done; `outcome.added` is what the piece added to the text after its seam.
- **Context.** A call's `prompt` is the last sentence, by your `sentences` function, of the latest piece of the recording that had been transcribed when the call's piece was first sent. A piece sent before any has answered has no prompt, unless `previousText` is set.
- **Retries.** A call that throws is made again, up to `attempts` tries for a piece in all (3 unless set). When a piece fails every try, the job rejects with `PiecesFailed`, which carries the piece's `index`, its `attempts` and the last error as `cause`. The pieces before it have been reported to `onPiece` by then; no piece after it is reported, even one that was transcribed.
- **Going on.** To go on after a failure, call `transcribePieces` with the pieces from the failed one on and `previousText` set to the text so far: every `outcome.added` that is not empty, joined by one space. The first of those pieces is joined to that text at its seam and takes its prompt from it, and the answer's `text` begins with it.
- **Stopping.** An aborted `signal` ends the job: no further try is made, and the job rejects with the signal's reason. Your function is given the same signal as `request.signal`.

The join is `mergeSeam(previous, next)`, exported beside the job. It drops from the start of `next` the longest run of 2 to 20 words that also ends `previous`. Words are compared in lower case with the marks `. , ! ? ; : " ' ( ) [ ] { }` removed (`normalizeTranscriptText`, exported from `@framers/agentos/io/voice-pipeline`). The run may begin at the first, second or third word of `next`, since a cut can leave part of a word at the start of a piece, and the one or two words before the run are dropped with it. With no such run, `next` is kept whole.

---

## Related Documentation

- [VOICE_PIPELINE.md](./VOICE_PIPELINE.md) — end-to-end voice session orchestration
- [RFC_EXTENSION_STANDARDS.md](../extensions/RFC_EXTENSION_STANDARDS.md) — extension pack authoring guide
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — high-level package architecture
