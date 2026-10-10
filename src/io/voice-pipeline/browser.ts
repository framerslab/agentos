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
