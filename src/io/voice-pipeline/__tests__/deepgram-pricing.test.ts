import { describe, expect, it } from 'vitest';
import {
  DEEPGRAM_PRE_RECORDED_PRICING,
  DEEPGRAM_STREAMING_ADDONS,
  DEEPGRAM_STREAMING_PRICING,
  deepgramPreRecordedPricing,
  deepgramStreamingPricing,
} from '../providers/deepgramPricing.js';
import { sttEntryPricePerMinute } from '../env-constructor.js';
import { openAITranscriptionPricing } from '../../../core/llm/providers/implementations/openaiPricing.js';
import { minutesMicro, toMicro } from '../../../safety/runtime/SpendReservations.js';

// Synthetic rate assertions: nothing here contacts a provider. The streaming row is Deepgram's regular list price, not
// the lower price its pricing page shows for a limited time, so a bound read from it holds when the offer ends.
describe('dated transcription prices', () => {
  it('uses the streaming row for a live entry and keeps batch pricing separate', () => {
    expect(deepgramStreamingPricing('nova-3')).toBe(0.0077);
    expect(deepgramPreRecordedPricing('nova-3')).toBe(0.0043);
    expect(sttEntryPricePerMinute('deepgram:nova-3')).toBe(0.0077);
    expect(minutesMicro(60, toMicro(deepgramStreamingPricing('nova-3')!))).toBe(7_700);
    expect(minutesMicro(60, toMicro(deepgramPreRecordedPricing('nova-3')!))).toBe(4_300);
  });

  it('preserves the OpenAI estimate and its dated-model lookup', () => {
    expect(openAITranscriptionPricing('gpt-4o-mini-transcribe')).toBe(0.003);
    expect(openAITranscriptionPricing('gpt-4o-mini-transcribe-2026-10-14')).toBe(0.003);
    expect(sttEntryPricePerMinute('openai:gpt-4o-mini-transcribe')).toBe(0.003);
  });

  it.each([undefined, '', 'nova-2', 'nova-3-multi', 'nova-3-2026-10-14', 'constructor', '__proto__', 'toString'])(
    'does not invent a Deepgram price for %s',
    (model) => {
      expect(deepgramStreamingPricing(model)).toBeUndefined();
      expect(deepgramPreRecordedPricing(model)).toBeUndefined();
    },
  );

  it('does not allow a caller to mutate either shared table', () => {
    expect(Object.isFrozen(DEEPGRAM_STREAMING_PRICING)).toBe(true);
    expect(Object.isFrozen(DEEPGRAM_PRE_RECORDED_PRICING)).toBe(true);
    expect(Reflect.set(DEEPGRAM_STREAMING_PRICING, 'nova-3', 0)).toBe(false);
    expect(Reflect.set(DEEPGRAM_PRE_RECORDED_PRICING, 'nova-3', 0)).toBe(false);
    expect(deepgramStreamingPricing('nova-3')).toBe(0.0077);
    expect(deepgramPreRecordedPricing('nova-3')).toBe(0.0043);
  });
});

describe('optional streaming diarization price', () => {
  it('adds only the Deepgram streaming add-on and preserves the ordinary call', () => {
    expect(DEEPGRAM_STREAMING_ADDONS.diarization).toBe(0.0020);
    expect(sttEntryPricePerMinute('deepgram:nova-3', { diarize: true })).toBeCloseTo(0.0097, 8);
    expect(sttEntryPricePerMinute('deepgram:nova-3', { diarize: false })).toBe(0.0077);
    expect(sttEntryPricePerMinute('deepgram:nova-3', {})).toBe(0.0077);
    expect(sttEntryPricePerMinute('deepgram:nova-3')).toBe(0.0077);
    expect(sttEntryPricePerMinute('openai:gpt-4o-mini-transcribe', { diarize: true })).toBe(0.003);
    expect(deepgramPreRecordedPricing('nova-3')).toBe(0.0043);
  });

  it('leaves unknown rows unknown and rejects unsupported entry syntax', () => {
    for (const entry of ['deepgram:nova-2', 'deepgram:constructor', 'openai:no-such-model', 'elevenlabs:scribe_v1']) {
      expect(sttEntryPricePerMinute(entry, { diarize: true })).toBeUndefined();
    }
    expect(() => sttEntryPricePerMinute('device:moonshine-auto', { diarize: true })).toThrow(RangeError);
  });

  it('keeps the add-on frozen and converts the combined reference tariff to microdollars', () => {
    expect(Object.isFrozen(DEEPGRAM_STREAMING_ADDONS)).toBe(true);
    expect(Reflect.set(DEEPGRAM_STREAMING_ADDONS, 'diarization', 0)).toBe(false);
    const rate = sttEntryPricePerMinute('deepgram:nova-3', { diarize: true });
    if (rate === undefined) throw new Error('missing reference tariff');
    expect(minutesMicro(60, toMicro(rate))).toBe(9_700);
  });
});
