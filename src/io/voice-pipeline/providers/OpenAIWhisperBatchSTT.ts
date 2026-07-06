/**
 * @module voice-pipeline/providers/OpenAIWhisperBatchSTT
 *
 * Batch speech-to-text via OpenAI's Whisper transcription endpoint. Implements
 * {@link IBatchSTT} using a multipart upload of the complete audio buffer.
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

interface WhisperVerboseResponse {
  text?: string;
  duration?: number;
}

/** Configuration for the OpenAI Whisper batch STT provider. */
export interface OpenAIWhisperBatchSTTConfig {
  /** OpenAI API key. */
  apiKey: string;
  /** Model to use. @default 'whisper-1' */
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
    this.model = config.model ?? 'whisper-1';
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
    form.append('model', config?.model ?? this.model);
    form.append('language', config?.language ?? this.language);
    form.append('response_format', 'verbose_json');

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

    const data = (await res.json()) as WhisperVerboseResponse;
    const transcript = (data.text ?? '').trim();
    if (!transcript) {
      throw new EmptyTranscriptError(this.providerId);
    }
    const duration = data.duration ?? 0;
    return {
      transcript,
      durationMs: Math.round(duration * 1000),
      provider: this.providerId,
    };
  }
}
