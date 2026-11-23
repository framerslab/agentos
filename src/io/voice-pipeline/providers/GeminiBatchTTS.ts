/**
 * @module voice-pipeline/providers/GeminiBatchTTS
 *
 * One-shot speech synthesis through the Gemini Interactions API.
 */

import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { isQuotaError } from '../../../core/providers/quotaErrors.js';
import { inspectWavPcm16 } from '../audioFormat.js';
import type { BatchTTSConfig, BatchTTSResult, IBatchTTS, SpeechDirection } from '../types.js';

/** Configuration for the Gemini batch TTS provider. */
export interface GeminiBatchTTSConfig {
  /** A Gemini API key or a comma-separated pool of keys. */
  apiKey: string;
  /** TTS model. Defaults to Gemini 3.8 Flash TTS. */
  model?: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts';
  /** Default prebuilt voice. Defaults to Kore. */
  voice?: string;
  /** API base including its version. Defaults to https://generativelanguage.googleapis.com/v1beta. */
  baseUrl?: string;
  /** Injectable HTTP client. */
  fetchImpl?: typeof fetch;
}

/** Gemini TTS failure with a safe classification for callers to handle. */
export class GeminiTtsError extends Error {
  constructor(
    /** Failure category. */
    readonly kind: 'quota' | 'safety' | 'unknown_voice' | 'bad_request' | 'server',
  ) {
    super(`Gemini TTS failed (${kind})`);
    this.name = 'GeminiTtsError';
  }
}

type DirectionKey = keyof SpeechDirection;
type Span = { start: number; end: number };

function renderStyle(direction?: SpeechDirection): { style?: string; applied: DirectionKey[] } {
  const applied: DirectionKey[] = [];
  const values: string[] = [];
  const emotion = direction?.emotion?.trim();
  const delivery = direction?.delivery?.trim();
  if (emotion) {
    values.push(emotion);
    applied.push('emotion');
  }
  if (delivery) {
    values.push(delivery);
    applied.push('delivery');
  }
  if (direction?.pace) {
    values.push(`${direction.pace} pace`);
    applied.push('pace');
  }
  return { style: values.join(', ') || undefined, applied };
}

/** Formats Gemini's style annotation from the line's emotion, delivery, and pace. */
export function geminiStyle(direction?: SpeechDirection): string | undefined {
  return renderStyle(direction).style;
}

function firstWholeMatch(spoken: string, words: string): Span | undefined {
  const phrase = words.trim();
  if (!phrase) return undefined;
  const literal = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordChar = '[\\p{L}\\p{M}\\p{N}_]';
  const match = new RegExp(`(?<!${wordChar})${literal}(?!${wordChar})`, 'iu').exec(spoken);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

function renderTranscript(
  spoken: string,
  direction?: SpeechDirection,
): { transcript: string; applied: DirectionKey[] } {
  const applied = new Set<DirectionKey>();
  const emphasis: Span[] = [];
  const tags = new Map<number, string[]>();
  for (const word of direction?.emphasis ?? []) {
    const match = firstWholeMatch(spoken, word);
    if (!match) continue;
    const text = spoken.slice(match.start, match.end);
    if (text === text.toUpperCase()) continue;
    emphasis.push(match);
    applied.add('emphasis');
  }
  const addTag = (after: string, tag: string, field: 'pauses' | 'bursts') => {
    const match = firstWholeMatch(spoken, after);
    if (!match) return;
    const punctuation = /^\p{P}*/u.exec(spoken.slice(match.end))?.[0] ?? '';
    const offset = match.end + punctuation.length;
    tags.set(offset, [...(tags.get(offset) ?? []), tag]);
    applied.add(field);
  };
  for (const { after, length } of direction?.pauses ?? []) {
    addTag(after, `<${length} pause>`, 'pauses');
  }
  for (const { after, kind } of direction?.bursts ?? []) {
    addTag(after, `<${kind}>`, 'bursts');
  }
  if (!applied.size) return { transcript: spoken, applied: [] };

  // All offsets refer to the original transcript, even when capitalization
  // changes a word's length or several cues share an anchor.
  const stops = new Set([spoken.length, ...tags.keys()]);
  for (const { start, end } of emphasis) {
    stops.add(start);
    stops.add(end);
  }
  let transcript = '';
  let start = 0;
  for (const end of [...stops].sort((a, b) => a - b)) {
    const text = spoken.slice(start, end);
    const stressed = emphasis.some((span) => span.start <= start && end <= span.end);
    transcript += stressed ? text.toUpperCase() : text;
    const inline = tags.get(end);
    if (inline) {
      transcript += ` ${inline.join(' ')}`;
      if (end < spoken.length && !/\s/u.test(spoken[end])) transcript += ' ';
    }
    start = end;
  }
  return { transcript, applied: [...applied] };
}

/** Formats the transcript with Gemini inline tags and capitalization for emphasis. */
export function geminiTranscript(spoken: string, direction?: SpeechDirection): string {
  return renderTranscript(spoken, direction).transcript;
}

interface InteractionResponse {
  status?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }>;
  error?: { status?: string; message?: string };
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

function classifyError(status: number, error?: InteractionResponse['error']): GeminiTtsError {
  if (status >= 500) return new GeminiTtsError('server');
  if (isQuotaError(status, typeof error?.status === 'string' ? error.status : '')) {
    return new GeminiTtsError('quota');
  }
  // Invalid voices share the HTTP status of other input errors. Look for explicit
  // voice messages such as 'Unknown voice' and 'Voice ... not found'.
  const message = typeof error?.message === 'string' ? error.message : '';
  if ((status === 400 || status === 404) &&
      /\b(?:(?:unknown|invalid|unrecognized|unsupported) voice|voice\b.*(?:not found|not supported|does not exist))/i.test(message)) {
    return new GeminiTtsError('unknown_voice');
  }
  return new GeminiTtsError('bad_request');
}

function lastAudioData(response?: InteractionResponse): string | undefined {
  let data: string | undefined;
  for (const step of Array.isArray(response?.steps) ? response.steps : []) {
    if (step?.type && step.type !== 'model_output') continue;
    for (const part of Array.isArray(step?.content) ? step.content : []) {
      if (part?.type === 'audio' && typeof part.data === 'string' && part.data) data = part.data;
    }
  }
  return data;
}

function tokenCount(value?: number): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Batch speech provider that returns 24 kHz mono PCM16 WAV audio. */
export class GeminiBatchTTS implements IBatchTTS {
  /** Identifier used in synthesis results. */
  readonly providerId = 'gemini-tts';

  private readonly keyPool: ApiKeyPool;
  private readonly model: NonNullable<GeminiBatchTTSConfig['model']>;
  private readonly voice: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiBatchTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.model = config.model ?? 'gemini-3.8-flash-tts';
    this.voice = config.voice ?? 'Kore';
    const baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/interactions`;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  private async request(key: string, body: string): Promise<InteractionResponse> {
    let response: Response;
    let result: InteractionResponse | undefined;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      result = await response.json().catch(() => undefined);
    } catch {
      throw new GeminiTtsError('server');
    }
    if (!response.ok) throw classifyError(response.status, result?.error);
    // Incomplete interactions may contain a WAV of only part of the line.
    if (result?.status !== 'completed') throw new GeminiTtsError('server');
    return result;
  }

  /** Synthesizes one complete line, with optional speech direction. */
  async synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult> {
    const model = config?.model ?? this.model;
    if (model !== 'gemini-3.8-flash-tts' && model !== 'gemini-3.8-flash-lite-tts') {
      throw new GeminiTtsError('bad_request');
    }
    const { style, applied } = renderStyle(config?.direction);
    const { transcript, applied: inlineApplied } = renderTranscript(text, config?.direction);
    const appliedDirection = [...applied, ...inlineApplied];
    const body = JSON.stringify({
      model,
      store: false,
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text: transcript,
          ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}),
        }],
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: config?.voice ?? this.voice }] },
    });

    const key = this.keyPool.next();
    if (!key) throw new GeminiTtsError('bad_request');
    let result: InteractionResponse;
    try {
      result = await this.request(key, body);
    } catch (error) {
      if (!(error instanceof GeminiTtsError) || error.kind !== 'quota' || this.keyPool.size < 2) {
        throw error;
      }
      this.keyPool.markExhausted(key);
      if (!this.keyPool.usable()) throw error;
      const nextKey = this.keyPool.next();
      result = await this.request(nextKey, body).catch((retryError: unknown) => {
        if (retryError instanceof GeminiTtsError && retryError.kind === 'quota') {
          this.keyPool.markExhausted(nextKey);
        }
        throw retryError;
      });
    }

    const data = lastAudioData(result);
    if (!data) throw new GeminiTtsError('safety');
    const audio = Buffer.from(data, 'base64');
    let durationMs: number;
    try {
      durationMs = inspectWavPcm16(audio, 24_000).durationMs;
    } catch {
      throw new GeminiTtsError('server');
    }
    const textTokens = tokenCount(result.usage?.total_input_tokens);
    // Estimate Gemini speech output at 25 audio tokens per second when usage is absent.
    const audioTokens = tokenCount(result.usage?.total_output_tokens) ?? Math.ceil(durationMs * 25 / 1000);
    return {
      audio,
      format: 'wav',
      durationMs,
      provider: this.providerId,
      ...(appliedDirection.length ? { appliedDirection } : {}),
      usage: { ...(textTokens !== undefined ? { textTokens } : {}), audioTokens },
    };
  }
}
