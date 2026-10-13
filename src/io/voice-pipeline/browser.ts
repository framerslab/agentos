/**
 * @module @framers/agentos/io/voice-pipeline/browser
 *
 * The voice pipeline's browser entry: modules that import no Node built-in and
 * no package, so a browser bundle can take them. The Node entry,
 * `@framers/agentos/io/voice-pipeline`, carries all of this as well, with the
 * providers, transports and orchestrator that run on a server.
 *
 * A test walks this entry's built module graph and fails on any import that
 * is not one of the library's own modules, so a module added here keeps to
 * that.
 *
 * @example
 * ```typescript
 * import { TranscriptLedger, transcriptEventFromLiveKit } from '@framers/agentos/io/voice-pipeline/browser';
 * import { StreamingSTTChain, type StreamingSTTSession } from '@framers/agentos/io/voice-pipeline/browser';
 * ```
 */

// A live transcript as lines keyed by item id, and LiveKit's transcription streams read into it.
export {
  LIVEKIT_TRANSCRIPTION_ATTRIBUTES,
  LIVEKIT_TRANSCRIPTION_TOPIC,
  TRANSCRIPTION_FAILED_ATTRIBUTE,
  TRANSCRIPTION_TIME_ATTRIBUTES,
  TranscriptLedger,
  transcriptEventFromLiveKit,
  type LedgerEvent,
  type LedgerItem,
  type TranscriptLedgerOptions,
} from './transcriptLedger.js';

// An input's level and the watch for an input that carries no sound; inputLevel.ts imports nothing.
export { InputSilenceWatch, inputLevelDb, type InputSilenceWatchOptions } from './inputLevel.js';

// Whether a given sentence was said in a transcript's first lines; phraseHeard.ts imports only the library's word
// rule, cognition/library/tokens.ts, which imports nothing.
export { phraseHeard, type HeardLine, type PhraseHeardOptions, type PhraseHeardResult } from './phraseHeard.js';

// The entries a speech-to-text chain is built from, and their parser; sttEntries.ts imports nothing.
export { STT_CHAIN_VENDORS, parseSttEntry, type SttChainVendor, type SttEntry } from './sttEntries.js';

// Every type of the streaming contracts. The export is of types alone, so the call runtime's two fence
// functions in types.ts (sameVoiceGeneration and copyAudioIdentity) are not this entry's.
export type * from './types.js';

// The emitter the contracts extend, and the browser-safe sessions' base.
export { VoiceEventEmitter, type EventEmitterLike, type VoiceEventListener } from './VoiceEventEmitter.js';

// The speech-to-text chain and its parts.
export {
  StreamingSTTChain,
  type StreamingSTTChainOptions,
  type ProviderSelectedEvent,
  type ProviderFailedEvent,
  type ProviderFailoverEvent,
} from './providers/StreamingSTTChain.js';
export {
  CircuitBreaker,
  type BreakerState,
  type CircuitBreakerOptions,
  type StateChangeEvent,
} from './CircuitBreaker.js';
export {
  VoiceMetricsReporter,
  type VoiceMetricEvent,
  type VoiceMetricListener,
} from './VoiceMetricsReporter.js';
export {
  VoicePipelineError,
  AggregateVoiceError,
  type HealthErrorClass,
  type VoicePipelineErrorInit,
} from './VoicePipelineError.js';
export {
  defaultCapabilities,
  supportsLanguage,
  type HealthyProvider,
  type ProviderCapabilities,
  type HealthCheckResult,
} from './HealthyProvider.js';

// On-device streaming STT: Moonshine through WebAssembly.
export {
  MoonshineBrowserSTT,
  MOONSHINE_STREAMING_MODEL_FILES,
  checkMoonshineBrowserSupport,
  chooseMoonshineModel,
  readMoonshineDeviceSignals,
  loadMoonshineWasm,
  type MoonshineBrowserSTTConfig,
  type MoonshineLoadProgress,
  type MoonshineModelSize,
  type MoonshineModelChoice,
  type MoonshineDeviceSignals,
  type MoonshineBrowserScope,
  type MoonshineBrowserSupport,
  type MoonshineBrowserSupportOptions,
  type MoonshineBrowserRequirement,
  type MoonshineWasmModule,
  type MoonshineTranscriberLike,
  type MoonshineStreamLike,
  type MoonshineWorkerHostLike,
  type MoonshineLineLike,
  type MoonshineLineEvent,
  type MoonshineLineListener,
  type MoonshineWordLike,
  type MoonshineLoadOptionsLike,
  type MoonshineModelSource,
  type MoonshineProgressReport,
} from './providers/MoonshineBrowserSTT.js';

// The client transcript message's helpers: a client that transcribes on its
// own device sends its transcripts in place of audio.
export {
  toClientTranscriptMessage,
  isClientTranscriptMessage,
  transcriptEventFromClient,
} from './clientTranscript.js';
