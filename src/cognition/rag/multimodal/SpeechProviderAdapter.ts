/**
 * @module rag/multimodal/SpeechProviderAdapter
 *
 * Adapts the voice-pipeline's {@link SpeechToTextProvider} to the narrow
 * {@link ISpeechToTextProvider} interface expected by the multimodal RAG
 * indexer.
 *
 * ## Why this adapter exists
 *
 * The speech subsystem (`src/speech/`) and the multimodal RAG pipeline
 * (`src/rag/multimodal/`) each define their own STT contract:
 *
 * | Contract                  | Input                | Output                          |
 * |---------------------------|----------------------|---------------------------------|
 * | `SpeechToTextProvider`    | `SpeechAudioInput`   | `SpeechTranscriptionResult`     |
 * | `ISpeechToTextProvider`   | `Buffer`             | `string`                        |
 *
 * The voice pipeline's providers (Whisper, Deepgram, AssemblyAI, Azure)
 * implement the richer `SpeechToTextProvider` contract. This adapter
 * wraps any of them so the multimodal indexer can consume them without
 * requiring separate STT configuration.
 *
 * ## Mapping details
 *
 * - **Input**: The raw `Buffer` is wrapped in a `SpeechAudioInput` with
 *   a default MIME type of `audio/wav`. The optional `language` parameter
 *   is forwarded via `SpeechTranscriptionOptions.language`.
 *
 * - **Output**: The full `SpeechTranscriptionResult` is reduced to just
 *   the `text` string. Rich metadata (segments, confidence, usage) is
 *   intentionally discarded because the indexer only needs the text for
 *   embedding generation.
 *
 * @see {@link SpeechToTextProvider} for the voice pipeline contract.
 * @see {@link ISpeechToTextProvider} for the multimodal indexer contract.
 * @see {@link SpeechProviderResolver} for resolving STT providers.
 *
 * @example
 * ```typescript
 * import { SpeechRuntime } from '../../../io/speech/SpeechRuntime.js';
 * import { SpeechProviderAdapter } from './SpeechProviderAdapter.js';
 *
 * // SpeechRuntime builds the STT providers whose keys are set.
 * const stt = new SpeechRuntime({ env: process.env }).getSTT();
 * if (!stt) throw new Error('No speech-to-text provider is configured');
 * const adapter = new SpeechProviderAdapter(stt);
 *
 * const indexer = new MultimodalIndexer({ sttProvider: adapter, ... });
 * ```
 */

import type { SpeechToTextProvider } from '../../../io/speech/types.js';
import type { ISpeechToTextProvider } from './types.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Bridges the voice-pipeline's `SpeechToTextProvider` to the multimodal
 * indexer's `ISpeechToTextProvider` interface.
 *
 * Converts raw `Buffer` audio into the `SpeechAudioInput` shape expected
 * by voice providers, forwards the language hint through
 * `SpeechTranscriptionOptions`, and extracts the plain transcript text
 * from the rich `SpeechTranscriptionResult`.
 *
 * @example
 * ```typescript
 * const whisper = resolver.resolveSTT();
 * const adapted = new SpeechProviderAdapter(whisper);
 *
 * // Now usable by the multimodal indexer:
 * const text = await adapted.transcribe(audioBuffer, 'en');
 * ```
 */
export class SpeechProviderAdapter implements ISpeechToTextProvider {
  /**
   * The underlying voice-pipeline STT provider being adapted.
   * Held as a readonly reference — the caller retains ownership.
   */
  private readonly _provider: SpeechToTextProvider;

  /**
   * Default MIME type applied to raw audio buffers when no format
   * information is available. WAV is the most universally supported
   * format across STT providers.
   */
  private readonly _defaultMimeType: string;

  /**
   * Create a new adapter wrapping a voice-pipeline STT provider.
   *
   * @param provider - A configured `SpeechToTextProvider` instance
   *   (e.g. Whisper, Deepgram, AssemblyAI, Azure Speech).
   * @param defaultMimeType - MIME type to assume for raw audio buffers.
   *   Defaults to `'audio/wav'` which is accepted by all major STT
   *   providers. Override to `'audio/mpeg'` or `'audio/ogg'` when
   *   indexing MP3/OGG files.
   *
   * @throws {Error} If provider is null or undefined.
   *
   * @example
   * ```typescript
   * const adapter = new SpeechProviderAdapter(whisperProvider);
   * const mp3Adapter = new SpeechProviderAdapter(whisperProvider, 'audio/mpeg');
   * ```
   */
  constructor(provider: SpeechToTextProvider, defaultMimeType = 'audio/wav') {
    if (!provider) {
      throw new Error(
        'SpeechProviderAdapter: a SpeechToTextProvider instance is required.',
      );
    }
    this._provider = provider;
    this._defaultMimeType = defaultMimeType;
  }

  /**
   * Transcribe audio data to text.
   *
   * Wraps the raw buffer in a `SpeechAudioInput` and delegates to the
   * underlying voice-pipeline provider. The rich transcription result
   * is reduced to the plain text string that the multimodal indexer
   * needs for embedding generation.
   *
   * @param audio - Raw audio data as a Buffer (WAV, MP3, OGG, etc.).
   * @param language - Optional BCP-47 language code hint for improved
   *   transcription accuracy (e.g. `'en'`, `'es'`, `'ja'`).
   * @returns The transcribed text content.
   *
   * @throws {Error} If the underlying STT provider fails.
   *
   * @example
   * ```typescript
   * const transcript = await adapter.transcribe(wavBuffer);
   * const spanishTranscript = await adapter.transcribe(audioBuffer, 'es');
   * ```
   */
  async transcribe(audio: Buffer, language?: string): Promise<string> {
    const result = await this._provider.transcribe(
      {
        data: audio,
        mimeType: this._defaultMimeType,
      },
      language ? { language } : undefined,
    );
    return result.text;
  }

  /**
   * Get the display name of the underlying STT provider.
   *
   * Useful for logging and diagnostics — lets callers identify which
   * voice-pipeline provider is actually handling transcription.
   *
   * @returns The provider's display name or ID string.
   *
   * @example
   * ```typescript
   * console.log(`STT via: ${adapter.getProviderName()}`); // "openai-whisper"
   * ```
   */
  getProviderName(): string {
    return this._provider.displayName ?? this._provider.id;
  }
}
