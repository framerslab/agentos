/**
 * @module voice-pipeline/providers/DeepgramPreRecordedBatchSTT
 *
 * Batch (one-shot) speech-to-text via Deepgram's pre-recorded transcription
 * endpoint. Implements {@link IBatchSTT} for transcribing a complete audio
 * buffer (voice notes, uploaded clips) — the batch counterpart to the
 * streaming {@link DeepgramStreamingSTT}.
 *
 * Raw audio bytes ride in the request body with the source MIME in
 * `Content-Type` (no multipart). An empty transcript is a REAL result (the
 * clip was silent), surfaced as {@link EmptyTranscriptError} so a fallback
 * chain treats it as terminal rather than a provider failure.
 */

import type { IBatchSTT, BatchSTTConfig, BatchSTTResult } from '../types.js';
import { EmptyTranscriptError } from './BatchSTTFallback.js';

/** Injectable fetch for tests; defaults to the global. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface DeepgramListenResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string }>;
    }>;
  };
}

/** Configuration for the Deepgram pre-recorded batch STT provider. */
export interface DeepgramPreRecordedBatchSTTConfig {
  /** Deepgram API key. */
  apiKey: string;
  /** Model to use. @default 'nova-3' */
  model?: string;
  /** BCP-47 language hint. @default 'en' */
  language?: string;
  /** Add punctuation + capitalization so stored transcripts read naturally. @default true */
  smartFormat?: boolean;
  /** Base listen endpoint. @default 'https://api.deepgram.com/v1/listen' */
  baseUrl?: string;
  /** Per-request timeout. @default 30000 */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_TIMEOUT_MS = 30_000;

export class DeepgramPreRecordedBatchSTT implements IBatchSTT {
  readonly providerId = 'deepgram-prerecorded';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly smartFormat: boolean;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: DeepgramPreRecordedBatchSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'nova-3';
    this.language = config.language ?? 'en';
    this.smartFormat = config.smartFormat ?? true;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async transcribe(audio: Buffer, config?: BatchSTTConfig): Promise<BatchSTTResult> {
    const mimeType = config?.mimeType ?? 'audio/webm';
    const params = new URLSearchParams({
      model: config?.model ?? this.model,
      language: config?.language ?? this.language,
    });
    if (this.smartFormat) params.set('smart_format', 'true');
    const url = `${this.baseUrl}?${params.toString()}`;

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': mimeType,
      },
      body: audio as unknown as BodyInit,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`deepgram_http_${res.status}${body ? `: ${body.slice(0, 240)}` : ''}`);
    }

    const data = (await res.json()) as DeepgramListenResponse;
    const transcript = (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
    if (!transcript) {
      throw new EmptyTranscriptError(this.providerId);
    }
    const duration = data.metadata?.duration ?? 0;
    return {
      transcript,
      durationMs: Math.round(duration * 1000),
      provider: this.providerId,
    };
  }
}
