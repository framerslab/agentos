import type {
  SpeechAudioInput,
  SpeechToTextProvider,
  SpeechTranscriptionOptions,
  SpeechTranscriptionResult,
  SpeechTranscriptionSegment,
} from '../../speech/types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';

/**
 * Configuration for the {@link DeepgramBatchSTTProvider}.
 *
 * @see {@link DeepgramBatchSTTProvider} for usage examples
 */
export interface DeepgramBatchSTTProviderConfig {
  /**
   * Deepgram API key used for authentication.
   * Sent as `Authorization: Token <apiKey>` in the request header.
   */
  apiKey: string;

  /**
   * Deepgram model to use for transcription. `nova-3` is Deepgram's
   * general-purpose model.
   * See https://developers.deepgram.com/docs/models-languages-overview for available models.
   * @default 'nova-3'
   */
  model?: string;

  /**
   * BCP-47 language code, e.g. `'en-US'`, `'fr-FR'`, `'de-DE'`.
   * When omitted, Deepgram applies automatic language detection.
   * @default 'en-US' (set at transcribe-time if not configured here)
   */
  language?: string;

  /**
   * Opt requests out of Deepgram's Model Improvement Program by sending
   * `mip_opt_out=true`. Off by default because Deepgram notes that opting out
   * has pricing impacts.
   * @default false
   */
  mipOptOut?: boolean;

  /**
   * Custom fetch implementation for dependency injection in tests.
   * When omitted, the global `fetch` is used. This allows tests to
   * intercept HTTP calls without mocking globals.
   * @default globalThis.fetch
   */
  fetchImpl?: typeof fetch;
}

/**
 * Shape of a single word returned in the Deepgram REST API response.
 *
 * The Deepgram batch API returns word-level data in
 * `results.channels[].alternatives[].words[]`. Each word includes timing,
 * confidence, and an optional speaker index when diarization is enabled.
 *
 * @see https://developers.deepgram.com/docs/getting-started-with-pre-recorded-audio
 */
interface DeepgramWord {
  /** The transcribed word text. */
  word: string;
  /** Start time in seconds from the beginning of the audio. */
  start: number;
  /** End time in seconds from the beginning of the audio. */
  end: number;
  /** Confidence score between 0.0 and 1.0 for this word. */
  confidence: number;
  /**
   * Zero-based speaker index when diarization is enabled (`diarize=true`).
   * Absent when diarization is disabled.
   */
  speaker?: number;
}

/**
 * Minimal typed subset of the Deepgram batch transcription REST API response.
 *
 * Only the fields we actually use are typed here to avoid coupling to
 * Deepgram's full response schema (which includes utterances, paragraphs,
 * summaries, etc. depending on enabled features).
 *
 * @see https://developers.deepgram.com/reference/pre-recorded
 */
interface DeepgramResponse {
  /** Transcription results organized by audio channels. */
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        /** Full transcript text for this alternative. */
        transcript?: string;
        /** Overall confidence score for this alternative (0.0–1.0). */
        confidence?: number;
        /** Word-level timing and speaker data. */
        words?: DeepgramWord[];
      }>;
    }>;
  };
  /** Audio metadata returned by Deepgram. */
  metadata?: {
    /** Total audio duration in seconds. */
    duration?: number;
  };
}

/**
 * Maps Deepgram word-level data to {@link SpeechTranscriptionSegment} objects.
 *
 * Each word is promoted to its own segment so that per-word timing and speaker
 * information is preserved in the normalized result. This 1:1 word-to-segment
 * mapping enables downstream consumers to reconstruct speaker-attributed
 * timelines at the finest granularity Deepgram provides.
 *
 * Deepgram returns times in seconds (unlike AssemblyAI which uses milliseconds),
 * so no unit conversion is needed here.
 *
 * @param words - Array of Deepgram word objects from the API response.
 * @returns An array of normalized transcription segments, one per word.
 *
 * @see {@link DeepgramWord} for the input shape
 * @see {@link SpeechTranscriptionSegment} for the output shape
 */
function wordsToSegments(words: DeepgramWord[]): SpeechTranscriptionSegment[] {
  return words.map((w) => ({
    text: w.word,
    startTime: w.start,
    endTime: w.end,
    confidence: w.confidence,
    speaker: w.speaker,
    words: [
      {
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      },
    ],
  }));
}

/**
 * Speech-to-text provider that uses the Deepgram batch (pre-recorded) REST API.
 *
 * ## REST API Contract
 *
 * - **Endpoint:** `POST https://api.deepgram.com/v1/listen`
 * - **Authentication:** `Authorization: Token <apiKey>` header
 * - **Content-Type:** Set to the audio's MIME type (e.g. `audio/wav`)
 * - **Body:** Raw audio bytes sent directly (no multipart form)
 * - **Query parameters:** `model`, `punctuate`, `diarize`, `language`
 * - **Response:** JSON containing `results.channels[].alternatives[]` with
 *   transcript text, confidence scores, and optional word-level timing
 *
 * ## Word-Level Diarization Mapping
 *
 * When `enableSpeakerDiarization` is `true`, the `diarize=true` query parameter
 * is set. Deepgram then includes a `speaker` field (zero-based integer index) on
 * each word in the response. These speaker indices are preserved through the
 * `wordsToSegments()` mapping into the normalized result.
 *
 * ## Error Handling
 *
 * Non-2xx responses from Deepgram trigger an `Error` with the HTTP status code
 * and response body text included in the message for debugging. Network-level
 * errors (DNS failures, timeouts) propagate as-is from the fetch implementation.
 *
 * Streaming is NOT supported by this provider — use a Deepgram WebSocket adapter
 * for real-time transcription.
 *
 * @see {@link DeepgramBatchSTTProviderConfig} for configuration options
 * See `wordsToSegments()` for the word-to-segment mapping logic.
 *
 * @example
 * ```ts
 * const provider = new DeepgramBatchSTTProvider({
 *   apiKey: process.env.DEEPGRAM_API_KEY!,
 *   model: 'nova-3',
 * });
 * const result = await provider.transcribe(
 *   { data: audioBuffer, mimeType: 'audio/wav' },
 *   { enableSpeakerDiarization: true },
 * );
 * console.log(result.text);
 * console.log(result.segments?.map(s => `[Speaker ${s.speaker}] ${s.text}`));
 * ```
 */
export class DeepgramBatchSTTProvider implements SpeechToTextProvider {
  /** Unique provider identifier used for registration and resolution. */
  public readonly id = 'deepgram-batch';

  /** Human-readable display name for UI and logging. */
  public readonly displayName = 'Deepgram (Batch)';

  /** This provider uses synchronous HTTP requests, not WebSocket streaming. */
  public readonly supportsStreaming = false;

  /** Fetch implementation — injected for testability, defaults to global fetch. */
  private readonly fetchImpl: typeof fetch;

  /**
   * Creates a new DeepgramBatchSTTProvider.
   *
   * @param config - Provider configuration including API key and optional defaults.
   *
   * @example
   * ```ts
   * const provider = new DeepgramBatchSTTProvider({
   *   apiKey: 'dg-xxxx',
   *   model: 'nova-3',
   *   language: 'en-US',
   * });
   * ```
   */
  private readonly keyPool: ApiKeyPool;

  constructor(private readonly config: DeepgramBatchSTTProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.keyPool = new ApiKeyPool(config.apiKey);
  }

  /**
   * Returns the human-readable provider name.
   *
   * @returns The display name string `'Deepgram (Batch)'`.
   *
   * @example
   * ```ts
   * provider.getProviderName(); // 'Deepgram (Batch)'
   * ```
   */
  getProviderName(): string {
    return this.displayName;
  }

  /**
   * Transcribes an audio buffer using the Deepgram pre-recorded API.
   *
   * Sends the raw audio bytes as the request body (not multipart form) with
   * the appropriate Content-Type header. The response is parsed and normalized
   * into a {@link SpeechTranscriptionResult}.
   *
   * @param audio - Raw audio data and associated metadata (buffer, MIME type,
   *   duration). The `data` buffer is sent directly as the request body.
   * @param options - Optional transcription settings. Supports `model`,
   *   `language`, and `enableSpeakerDiarization` overrides.
   * @returns A promise resolving to the normalized transcription result with
   *   text, confidence, timing, and optional speaker-attributed segments.
   * @throws {Error} When the Deepgram API returns a non-2xx status code.
   *   The error message includes the HTTP status and response body for debugging.
   *
   * @example
   * ```ts
   * const result = await provider.transcribe(
   *   { data: wavBuffer, mimeType: 'audio/wav', durationSeconds: 5.2 },
   *   { language: 'fr-FR', enableSpeakerDiarization: true },
   * );
   * ```
   */
  async transcribe(
    audio: SpeechAudioInput,
    options: SpeechTranscriptionOptions = {}
  ): Promise<SpeechTranscriptionResult> {
    // Resolve configuration with fallback chain: options > config > defaults
    const model = options.model ?? this.config.model ?? 'nova-3';
    const lang = options.language ?? this.config.language ?? 'en-US';
    const diarize = options.enableSpeakerDiarization ?? false;

    // Build the Deepgram REST API URL with query parameters.
    // Punctuation is always enabled for better transcript readability.
    const url =
      `https://api.deepgram.com/v1/listen` +
      `?model=${encodeURIComponent(model)}` +
      `&punctuate=true` +
      `&diarize=${diarize}` +
      `&language=${encodeURIComponent(lang)}` +
      (this.config.mipOptOut === true ? '&mip_opt_out=true' : '');

    // Use the audio's actual MIME type so Deepgram can decode correctly.
    // Deepgram supports wav, mp3, ogg, flac, webm, and many other formats.
    const contentType = audio.mimeType ?? 'audio/wav';

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.keyPool.next()}`,
        'Content-Type': contentType,
      },
      // Cast needed because SpeechAudioInput.data is typed as Buffer but
      // fetch expects BodyInit (Blob | ArrayBuffer | string | etc.)
      body: audio.data as any,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Deepgram transcription failed (${response.status}): ${message}`);
    }

    const payload = (await response.json()) as DeepgramResponse;

    // Extract the first channel's first alternative — Deepgram always returns
    // at least one channel with one alternative for valid audio input.
    const firstAlternative = payload.results?.channels?.[0]?.alternatives?.[0];
    const transcript = firstAlternative?.transcript ?? '';
    const confidence = firstAlternative?.confidence;
    const words = firstAlternative?.words ?? [];

    // Prefer the API's reported duration over the client-provided estimate
    const durationSeconds = payload.metadata?.duration ?? audio.durationSeconds;

    return {
      text: transcript,
      language: lang,
      durationSeconds,
      confidence,
      cost: 0, // Cost tracking is handled at a higher layer
      segments: words.length > 0 ? wordsToSegments(words) : undefined,
      providerResponse: payload,
      isFinal: true, // Batch API always returns final results
      usage: {
        durationMinutes: (durationSeconds ?? 0) / 60,
        modelUsed: model,
      },
    };
  }
}
