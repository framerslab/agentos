/**
 * @module voice-pipeline/providers/OpenAIWhisperBatchSTT
 *
 * Batch speech-to-text via OpenAI's transcription endpoint. Implements
 * {@link IBatchSTT} using a multipart upload of the complete audio buffer.
 * The default model is `gpt-transcribe`, which OpenAI recommends for recorded
 * speech; OpenAI removes `whisper-1` from the API on 2027-02-26.
 * Positioned as a fallback behind {@link DeepgramPreRecordedBatchSTT} in a
 * {@link BatchSTTFallback} chain.
 *
 * An empty transcript surfaces as {@link EmptyTranscriptError} (silence is a
 * real result, not a provider failure).
 */

import type { IBatchSTT, BatchSTTConfig, BatchSTTResult } from '../types.js';
import { EmptyTranscriptError } from './BatchSTTFallback.js';

/** Injectable fetch for tests; defaults to the global. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface TranscriptionResponse {
  text?: string;
  /** Audio length in seconds, returned by `whisper-1` in `verbose_json`. */
  duration?: number;
  /** `gpt-transcribe` reports the audio length as `{ type: 'duration', seconds }`. */
  usage?: { type?: string; seconds?: number };
}

/** The model OpenAI recommends for transcribing recorded speech. */
const DEFAULT_MODEL = 'gpt-transcribe';

/** `gpt-transcribe` takes language hints as a `languages` list in place of `language`. */
function takesLanguageList(model: string): boolean {
  return model === 'gpt-transcribe' || model.startsWith('gpt-transcribe-');
}

/** Configuration for the OpenAI batch STT provider. */
export interface OpenAIWhisperBatchSTTConfig {
  /** OpenAI API key. */
  apiKey: string;
  /** Model to use. @default 'gpt-transcribe' */
  model?: string;
  /** BCP-47 language hint. @default 'en' */
  language?: string;
  /** Transcriptions endpoint. @default 'https://api.openai.com/v1/audio/transcriptions' */
  baseUrl?: string;
  /** Per-request timeout. @default 60000 */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAIWhisperBatchSTT implements IBatchSTT {
  readonly providerId = 'openai-whisper';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAIWhisperBatchSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.language = config.language ?? 'en';
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async transcribe(audio: Buffer, config?: BatchSTTConfig): Promise<BatchSTTResult> {
    const mimeType = config?.mimeType ?? 'audio/webm';
    const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'webm';
    const form = new FormData();
    form.append(
      'file',
      new Blob([audio as unknown as BlobPart], { type: mimeType }),
      `voice-note.${ext}`,
    );
    const model = config?.model ?? this.model;
    const language = config?.language ?? this.language;
    form.append('model', model);
    // gpt-transcribe reads its language hint from `languages`; OpenAI asks
    // callers not to send both fields.
    if (takesLanguageList(model)) form.append('languages[]', language);
    else form.append('language', language);
    // OpenAI's gpt- transcription models answer in json and report the
    // duration under `usage`. Every other model, whisper-1 and a
    // whisper-compatible server's own included, answers in verbose_json,
    // which carries the duration.
    form.append('response_format', model.startsWith('gpt-') ? 'json' : 'verbose_json');

    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`whisper_http_${res.status}${body ? `: ${body.slice(0, 240)}` : ''}`);
    }

    const data = (await res.json()) as TranscriptionResponse;
    const transcript = (data.text ?? '').trim();
    if (!transcript) {
      throw new EmptyTranscriptError(this.providerId);
    }
    const usageSeconds = data.usage?.type === 'duration' ? data.usage.seconds : undefined;
    const duration = data.duration ?? usageSeconds ?? 0;
    return {
      transcript,
      durationMs: Math.round(duration * 1000),
      provider: this.providerId,
    };
  }
}
