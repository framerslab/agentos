/**
 * @file openaiPricing.ts
 * @description OpenAI's list prices for its transcription models, which bill
 * by the minute of audio rather than by the token, in a module of its own so
 * that a caller can price audio before it is sent without loading a provider.
 */

/**
 * USD per minute of audio for OpenAI's transcription models, which bill by time rather than by token (OpenAI's
 * pricing page: its address and the day it was read go in this comment when a row is added or changed).
 */
export const OPENAI_TRANSCRIPTION_PRICING: Readonly<Record<string, number>> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-realtime-whisper': 0.017,
  // https://developers.openai.com/api/docs/pricing, read 8 October 2026: "$0.006 / minute", "$0.0045 / minute" and
  // "$0.017 / minute" in the transcription rows of gpt-4o-transcribe, gpt-transcribe and gpt-live-transcribe.
  'gpt-4o-transcribe': 0.006,
  'gpt-transcribe': 0.0045,
  'gpt-live-transcribe': 0.017,
};

/** A transcription model's price per minute; a dated snapshot without its own row takes its base model's. */
export function openAITranscriptionPricing(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  return OPENAI_TRANSCRIPTION_PRICING[modelId] ?? OPENAI_TRANSCRIPTION_PRICING[modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}
