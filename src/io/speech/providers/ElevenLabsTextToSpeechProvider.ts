import type {
  SpeechSynthesisOptions,
  SpeechSynthesisResult,
  SpeechVoice,
  TextToSpeechProvider,
} from '../types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { isQuotaError } from '../../../core/providers/quotaErrors.js';

/**
 * Configuration for the {@link ElevenLabsTextToSpeechProvider}.
 *
 * @see {@link ElevenLabsTextToSpeechProvider} for usage examples
 * @see https://docs.elevenlabs.io/api-reference/text-to-speech
 */
export interface ElevenLabsTextToSpeechProviderConfig {
  /**
   * ElevenLabs API key used for authentication.
   * Sent as the `xi-api-key` header value (not Bearer-style auth).
   */
  apiKey: string;

  /**
   * Base URL for the ElevenLabs API. Override for proxies or self-hosted instances.
   * @default 'https://api.elevenlabs.io/v1'
   */
  baseUrl?: string;

  /**
   * Default voice ID. ElevenLabs uses opaque IDs (not human-readable names).
   * @default 'EXAVITQu4vr4xnSDxMaL' (the "Sarah" voice)
   */
  voiceId?: string;

  /**
   * Default model ID for synthesis.
   * @default 'eleven_multilingual_v2'
   */
  model?: string;

  /**
   * Custom fetch implementation for dependency injection in tests.
   * @default globalThis.fetch
   */
  fetchImpl?: typeof fetch;
}

/** The base URL every request goes to when the configuration names none. */
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

/**
 * The model {@link ElevenLabsTextToSpeechProvider.synthesizeDialogue} names when the call names none. Text to
 * Dialogue runs on Eleven v4 and Eleven v3, and the endpoint itself defaults to `eleven_v3`, so the method always
 * sends a model.
 */
const DIALOGUE_DEFAULT_MODEL = 'eleven_v4';

/** The output format {@link ElevenLabsTextToSpeechProvider.synthesizeDialogue} names when the call names none. */
const DIALOGUE_DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/** The largest seed Text to Dialogue accepts; the API reference gives the range 0 to 4294967295. */
const DIALOGUE_MAX_SEED = 4294967295;

/** One line of a dialogue: what one speaker says, and the voice that says it. */
export interface ElevenLabsDialogueLine {
  /**
   * The words of the line. On Eleven v4 and v3, audio tags in square brackets (`[whispering]`, `[laughs]`) steer
   * the delivery of the line they sit in.
   */
  text: string;

  /** The ElevenLabs voice id that speaks the line. */
  voiceId: string;
}

/** Options of {@link ElevenLabsTextToSpeechProvider.synthesizeDialogue}. */
export interface ElevenLabsDialogueOptions {
  /**
   * The model. Text to Dialogue runs on Eleven v4 and Eleven v3. The constructor's `model` is not read here: it is
   * {@link ElevenLabsTextToSpeechProvider.synthesize}'s default, `eleven_multilingual_v2`, which this endpoint does
   * not run.
   * @default 'eleven_v4'
   */
  model?: string;

  /**
   * The audio format, as ElevenLabs writes it: codec, sample rate and bitrate (`mp3_44100_128`, `wav_44100`,
   * `pcm_24000`, `opus_48000_64`). Sent as the `output_format` query parameter. Some formats need a paid tier.
   * @default 'mp3_44100_128'
   */
  outputFormat?: string;

  /**
   * A whole number from 0 to 4294967295. ElevenLabs samples deterministically on a best-effort basis for repeated
   * requests with the same seed and parameters; it does not guarantee the same audio.
   */
  seed?: number;
}

/** One voice segment of a dialogue's audio: where a line, or part of one, starts and ends. */
export interface ElevenLabsDialogueSegment {
  /** The index of the input line this segment belongs to (`dialogue_input_index`). */
  lineIndex: number;

  /** The voice that speaks the segment. */
  voiceId: string;

  /** Where the segment starts in the audio, in seconds. */
  startSeconds: number;

  /** Where the segment ends in the audio, in seconds. */
  endSeconds: number;

  /** The segment's first character in {@link ElevenLabsCharacterAlignment.characters}. */
  characterStartIndex: number;

  /** The character after the segment's last in {@link ElevenLabsCharacterAlignment.characters} (exclusive). */
  characterEndIndex: number;
}

/** The time of each character of a dialogue's text in its audio. The three arrays run in step. */
export interface ElevenLabsCharacterAlignment {
  /** The characters, one per entry. */
  characters: string[];

  /** When each character starts, in seconds. */
  characterStartTimesSeconds: number[];

  /** When each character ends, in seconds. */
  characterEndTimesSeconds: number[];
}

/** What {@link ElevenLabsTextToSpeechProvider.synthesizeDialogue} returns. */
export interface ElevenLabsDialogueResult extends SpeechSynthesisResult {
  /** The output format the audio was asked for in, as sent. */
  outputFormat: string;

  /** The voice segments, in the order the API gave them, each with its line index and times. */
  segments: ElevenLabsDialogueSegment[];

  /** Each character's time in the text as written; absent when the answer has none. */
  alignment?: ElevenLabsCharacterAlignment;

  /** Each character's time in the text as normalized (numbers spelled out, for one); absent when the answer has none. */
  normalizedAlignment?: ElevenLabsCharacterAlignment;
}

/** An error answer from the ElevenLabs API, with its HTTP status and body. */
export class ElevenLabsApiError extends Error {
  /**
   * @param operation - What the request was for, named in the message.
   * @param status - The HTTP status of the answer.
   * @param body - The body of the answer, as text.
   */
  constructor(
    operation: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(`ElevenLabs ${operation} failed (${status}): ${body}`);
    this.name = 'ElevenLabsApiError';
  }
}

/**
 * Text-to-speech provider that uses the ElevenLabs TTS API.
 *
 * ## API Contract
 *
 * - **Endpoint:** `POST {baseUrl}/text-to-speech/{voiceId}`
 * - **Authentication:** `xi-api-key: <apiKey>` header
 * - **Content-Type:** `application/json`
 * - **Accept:** `audio/mpeg` (MP3 response)
 * - **Request body:** `{ text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost } }`
 * - **Response:** Raw MP3 audio bytes
 *
 * ## A dialogue with line times
 *
 * {@link synthesizeDialogue} voices several speakers in one request through Text to Dialogue with timestamps:
 * - **Endpoint:** `POST {baseUrl}/text-to-dialogue/with-timestamps?output_format=<format>`
 * - **Request body:** `{ inputs: [{ text, voice_id }], model_id, seed? }`
 * - **Response:** JSON with `audio_base64`, `voice_segments` (each with `dialogue_input_index` and its start and end
 *   seconds), and `alignment` and `normalized_alignment` when present
 * - **Reference:** https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps
 *
 * ## Voice Settings
 *
 * ElevenLabs exposes fine-grained voice control via `voice_settings`:
 * - **stability** (0.0–1.0) — Lower values = more expressive/variable, higher = more consistent
 * - **similarity_boost** (0.0–1.0) — Higher values make output more similar to the original voice
 * - **style** (0.0–1.0) — Style exaggeration (optional, only for v2+ models)
 * - **use_speaker_boost** (boolean) — Enhances speaker similarity (default: true)
 *
 * These can be passed via `options.providerSpecificOptions`.
 *
 * ## Voice ID Resolution
 *
 * The voice ID is resolved with the following priority:
 * 1. `options.voice` (per-call override)
 * 2. `config.voiceId` (constructor default)
 * 3. `options.providerSpecificOptions.voiceId` (legacy override path)
 * 4. `'EXAVITQu4vr4xnSDxMaL'` (hardcoded fallback — the "Sarah" voice)
 *
 * ## Voice Listing
 *
 * {@link listAvailableVoices} fetches the user's voice library from the
 * `/voices` endpoint and maps each entry to the normalized {@link SpeechVoice}
 * shape. Returns an empty array on API errors (graceful degradation).
 *
 * @see {@link ElevenLabsTextToSpeechProviderConfig} for configuration options
 *
 * @example
 * ```ts
 * const provider = new ElevenLabsTextToSpeechProvider({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 *   voiceId: 'pNInz6obpgDQGcFmaJgB', // "Adam"
 * });
 * const result = await provider.synthesize('Hello world', {
 *   providerSpecificOptions: { stability: 0.7, similarityBoost: 0.8 },
 * });
 * ```
 */
export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  /** Unique provider identifier used for registration and resolution. */
  public readonly id = 'elevenlabs';

  /** Human-readable display name for UI and logging. */
  public readonly displayName = 'ElevenLabs';

  /**
   * Streaming is supported — ElevenLabs offers a WebSocket streaming endpoint,
   * and even the REST endpoint can be consumed as a stream.
   */
  public readonly supportsStreaming = true;

  /** Fetch implementation — injected for testability, defaults to global fetch. */
  private readonly fetchImpl: typeof fetch;

  /** API key pool for round-robin rotation and quota failover. */
  private readonly keyPool: ApiKeyPool;

  /**
   * Creates a new ElevenLabsTextToSpeechProvider.
   *
   * @param config - Provider configuration including API key and optional defaults.
   *
   * @example
   * ```ts
   * const provider = new ElevenLabsTextToSpeechProvider({
   *   apiKey: 'xi-xxxx',
   *   voiceId: 'pNInz6obpgDQGcFmaJgB',
   *   model: 'eleven_multilingual_v2',
   * });
   * ```
   */
  constructor(private readonly config: ElevenLabsTextToSpeechProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.keyPool = new ApiKeyPool(config.apiKey);
  }

  /**
   * Returns the human-readable provider name.
   *
   * @returns The display name string `'ElevenLabs'`.
   *
   * @example
   * ```ts
   * provider.getProviderName(); // 'ElevenLabs'
   * ```
   */
  getProviderName(): string {
    return this.displayName;
  }

  /**
   * Synthesizes speech from text using the ElevenLabs TTS API.
   *
   * @param text - The text to convert to audio.
   * @param options - Optional synthesis settings. Use `providerSpecificOptions`
   *   to control ElevenLabs-specific voice settings (stability, similarityBoost,
   *   style, useSpeakerBoost).
   * @returns A promise resolving to the MP3 audio buffer and metadata.
   * @throws {Error} When the ElevenLabs API returns a non-2xx status code.
   *   Common causes: invalid API key (401), voice not found (404),
   *   character limit exceeded (400), or rate limit (429).
   *
   * @example
   * ```ts
   * const result = await provider.synthesize('Hello there!', {
   *   voice: 'pNInz6obpgDQGcFmaJgB',
   *   providerSpecificOptions: {
   *     stability: 0.3,       // More expressive
   *     similarityBoost: 0.9, // Closer to original voice
   *     style: 0.5,           // Moderate style exaggeration
   *   },
   * });
   * ```
   */
  async synthesize(
    text: string,
    options: SpeechSynthesisOptions = {}
  ): Promise<SpeechSynthesisResult> {
    // Voice ID resolution with 4-level fallback chain.
    // The providerSpecificOptions.voiceId path exists for backwards compat.
    const voiceId =
      options.voice ??
      this.config.voiceId ??
      (typeof options.providerSpecificOptions?.voiceId === 'string'
        ? options.providerSpecificOptions.voiceId
        : undefined) ??
      'EXAVITQu4vr4xnSDxMaL'; // Default "Sarah" voice

    const model = options.model ?? this.config.model ?? 'eleven_multilingual_v2';

    const baseUrl = this.config.baseUrl ?? 'https://api.elevenlabs.io/v1';
    const requestBody = JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        stability:
          typeof options.providerSpecificOptions?.stability === 'number'
            ? options.providerSpecificOptions.stability
            : 0.5,
        similarity_boost:
          typeof options.providerSpecificOptions?.similarityBoost === 'number'
            ? options.providerSpecificOptions.similarityBoost
            : 0.75,
        style:
          typeof options.providerSpecificOptions?.style === 'number'
            ? options.providerSpecificOptions.style
            : undefined,
        use_speaker_boost:
          typeof options.providerSpecificOptions?.useSpeakerBoost === 'boolean'
            ? options.providerSpecificOptions.useSpeakerBoost
            : true,
      },
    });

    const doFetch = (key: string) =>
      this.fetchImpl(`${baseUrl}/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: requestBody,
      });

    const key = this.keyPool.next();
    let response = await doFetch(key);

    if (!response.ok && this.keyPool.size > 1) {
      const errBody = await response.text().catch(() => '');
      if (isQuotaError(response.status, errBody)) {
        this.keyPool.markExhausted(key);
        response = await doFetch(this.keyPool.next());
      } else {
        throw new Error(`ElevenLabs synthesis failed (${response.status}): ${errBody}`);
      }
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`ElevenLabs synthesis failed (${response.status}): ${message}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
      audioBuffer,
      mimeType: 'audio/mpeg',
      cost: 0, // Cost tracking is handled at a higher layer
      voiceUsed: voiceId,
      providerName: this.displayName,
      usage: {
        characters: text.length,
        modelUsed: model,
      },
    };
  }

  /**
   * Voices a dialogue of several speakers in one request, through ElevenLabs' Text to Dialogue with timestamps,
   * and returns the audio with each line's place in it.
   *
   * The audio is the bytes ElevenLabs sent, decoded from base64 with no re-encode. Each voice segment comes back
   * with the index of its input line and its start and end seconds, in the order the API gave them; no segments are
   * merged. The character alignments come back when the answer has them.
   *
   * The key and the base URL are the ones {@link synthesize} uses: the `xi-api-key` header from the provider's key
   * pool, where a key that answers with a spent quota hands over to the next, and `config.baseUrl`.
   *
   * ElevenLabs' reference gives two limits the method leaves to the API: at most 10 unique voice ids per request,
   * and, for reliable generation, at most 2,000 characters of text across all lines; longer requests can end early
   * or return a validation error. Split a longer dialogue into requests.
   *
   * @param lines - The lines in speaking order, each with its text and voice id.
   * @param options - The model, the output format and an optional seed.
   * @returns The audio, its format, the voice segments and the character alignments when present.
   * @throws {RangeError} Before any request, for an empty dialogue, a line without text or voice id, or a seed that
   *   is not a whole number from 0 to 4294967295.
   * @throws {ElevenLabsApiError} When ElevenLabs answers with an error status (401 for a bad key, 422 for a request
   *   it refuses, 429 for a spent quota), with the status and the body.
   * @throws {Error} When a successful answer has no `audio_base64` or no well-formed `voice_segments`.
   *
   * @example
   * ```ts
   * const dialogue = await provider.synthesizeDialogue(
   *   [
   *     { text: 'Can you hear me?', voiceId: 'voice-a' },
   *     { text: 'Loud and clear.', voiceId: 'voice-b' },
   *   ],
   *   { model: 'eleven_v4', outputFormat: 'mp3_44100_128', seed: 7 },
   * );
   * for (const segment of dialogue.segments) {
   *   console.log(segment.lineIndex, segment.startSeconds, segment.endSeconds);
   * }
   * ```
   */
  async synthesizeDialogue(
    lines: readonly ElevenLabsDialogueLine[],
    options: ElevenLabsDialogueOptions = {}
  ): Promise<ElevenLabsDialogueResult> {
    // Checked through `unknown`: Array.isArray narrows a readonly array to `any[]`.
    if (!Array.isArray(lines as unknown) || lines.length === 0) {
      throw new RangeError('ElevenLabs dialogue needs at least one line');
    }
    lines.forEach((line, index) => {
      if (typeof line?.text !== 'string' || line.text.trim() === '') {
        throw new RangeError(`ElevenLabs dialogue line ${index} has no text`);
      }
      if (typeof line.voiceId !== 'string' || line.voiceId.trim() === '') {
        throw new RangeError(`ElevenLabs dialogue line ${index} has no voice id`);
      }
    });
    const { seed } = options;
    if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed <= DIALOGUE_MAX_SEED)) {
      throw new RangeError(
        `ElevenLabs dialogue seed must be a whole number from 0 to ${DIALOGUE_MAX_SEED} (got ${String(seed)})`
      );
    }

    const model = options.model ?? DIALOGUE_DEFAULT_MODEL;
    const outputFormat = options.outputFormat ?? DIALOGUE_DEFAULT_OUTPUT_FORMAT;
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/text-to-dialogue/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`;
    const requestBody = JSON.stringify({
      inputs: lines.map((line) => ({ text: line.text, voice_id: line.voiceId })),
      model_id: model,
      ...(seed === undefined ? {} : { seed }),
    });

    const doFetch = (key: string) =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: requestBody,
      });

    const key = this.keyPool.next();
    let response = await doFetch(key);

    if (!response.ok && this.keyPool.size > 1) {
      const errBody = await response.text().catch(() => '');
      if (!isQuotaError(response.status, errBody)) {
        throw new ElevenLabsApiError('dialogue', response.status, errBody);
      }
      this.keyPool.markExhausted(key);
      response = await doFetch(this.keyPool.next());
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new ElevenLabsApiError('dialogue', response.status, errBody);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('ElevenLabs dialogue answer is not JSON');
    }
    if (!isRecord(payload) || typeof payload.audio_base64 !== 'string' || payload.audio_base64 === '') {
      throw new Error('ElevenLabs dialogue answer has no audio_base64');
    }

    const segments = readDialogueSegments(payload.voice_segments);
    const alignment = readCharacterAlignment(payload.alignment);
    const normalizedAlignment = readCharacterAlignment(payload.normalized_alignment);

    return {
      audioBuffer: Buffer.from(payload.audio_base64, 'base64'),
      mimeType: dialogueMimeType(outputFormat),
      cost: 0, // Cost tracking is handled at a higher layer
      providerName: this.displayName,
      usage: {
        characters: lines.reduce((total, line) => total + line.text.length, 0),
        modelUsed: model,
      },
      outputFormat,
      segments,
      ...(alignment ? { alignment } : {}),
      ...(normalizedAlignment ? { normalizedAlignment } : {}),
    };
  }

  /**
   * Fetches the user's voice library from the ElevenLabs API.
   *
   * Returns available voices mapped to the normalized {@link SpeechVoice} shape.
   * Gracefully returns an empty array on API errors (e.g. network failure,
   * invalid key) to avoid breaking voice selection UIs.
   *
   * The voice library includes both ElevenLabs' pre-made voices and any
   * custom/cloned voices in the user's account.
   *
   * @returns A promise resolving to an array of available voices, or an empty
   *   array if the API call fails.
   *
   * @example
   * ```ts
   * const voices = await provider.listAvailableVoices();
   * const rachel = voices.find(v => v.name === 'Rachel');
   * ```
   */
  async listAvailableVoices(): Promise<SpeechVoice[]> {
    const response = await this.fetchImpl(
      `${this.config.baseUrl ?? 'https://api.elevenlabs.io/v1'}/voices`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      }
    );

    // Graceful degradation: return empty list on API failure rather than
    // throwing, since voice listing is typically used for UI population
    // and should not block core functionality.
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as { voices?: Array<Record<string, unknown>> };
    return (payload.voices ?? [])
      .filter((voice) => typeof voice === 'object' && voice !== null)
      .map((voice) => {
        // Extract labels object for accent/language metadata
        const labels =
          typeof voice.labels === 'object' && voice.labels !== null
            ? (voice.labels as Record<string, unknown>)
            : {};

        return {
          id: typeof voice.voice_id === 'string' ? voice.voice_id : '',
          name: typeof voice.name === 'string' ? voice.name : 'Unknown',
          lang:
            typeof labels.accent === 'string'
              ? labels.accent
              : typeof labels.language === 'string'
              ? labels.language
              : 'various',
          description:
            typeof voice.description === 'string' ? voice.description : undefined,
          provider: this.id,
        };
      })
      // Filter out entries with empty IDs (malformed API response entries)
      .filter((voice) => voice.id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Maps the answer's `voice_segments`. The field is required by the API reference and is what a caller reads the
 * line times from, so a missing list or a segment without its numbers is refused rather than skipped: a skipped
 * segment would leave a line without its times and nothing to say so.
 */
function readDialogueSegments(value: unknown): ElevenLabsDialogueSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('ElevenLabs dialogue answer has no voice_segments list');
  }
  return value.map((segment, position) => {
    if (
      !isRecord(segment) ||
      !isWholeNumber(segment.dialogue_input_index) ||
      typeof segment.voice_id !== 'string' ||
      !isFiniteNumber(segment.start_time_seconds) ||
      !isFiniteNumber(segment.end_time_seconds) ||
      !isWholeNumber(segment.character_start_index) ||
      !isWholeNumber(segment.character_end_index)
    ) {
      throw new Error(`ElevenLabs dialogue answer has a malformed voice segment at position ${position}`);
    }
    return {
      lineIndex: segment.dialogue_input_index,
      voiceId: segment.voice_id,
      startSeconds: segment.start_time_seconds,
      endSeconds: segment.end_time_seconds,
      characterStartIndex: segment.character_start_index,
      characterEndIndex: segment.character_end_index,
    };
  });
}

/** Maps an `alignment` or `normalized_alignment`; `undefined` when the answer has none (absent or null). */
function readCharacterAlignment(value: unknown): ElevenLabsCharacterAlignment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const characters = value.characters;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    return undefined;
  }
  return {
    characters: characters.map((character) => String(character)),
    characterStartTimesSeconds: starts.map((time) => Number(time)),
    characterEndTimesSeconds: ends.map((time) => Number(time)),
  };
}

/** The MIME type of an ElevenLabs output format; the formats whose container the reference does not state get none. */
function dialogueMimeType(outputFormat: string): string {
  if (outputFormat.startsWith('mp3_')) {
    return 'audio/mpeg';
  }
  if (outputFormat.startsWith('wav_')) {
    return 'audio/wav';
  }
  return 'application/octet-stream';
}
