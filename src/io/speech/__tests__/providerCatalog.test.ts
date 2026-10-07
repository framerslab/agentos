import { describe, it, expect } from 'vitest';
import { findSpeechProviderCatalogEntry, SPEECH_PROVIDER_CATALOG } from '../providerCatalog.js';

/**
 * Tests for the static speech provider catalog — verifies that key provider
 * entries exist with the expected metadata (streaming, availability, kind).
 * These tests act as regression guards against accidental catalog changes.
 */
describe('providerCatalog', () => {
  it('should have a deepgram-aura TTS entry with streaming enabled', () => {
    const entry = findSpeechProviderCatalogEntry('deepgram-aura');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('tts');
    expect(entry!.streaming).toBe(true);
    expect(entry!.envVars).toContain('DEEPGRAM_API_KEY');
  });

  it('should have a deepgram-batch entry with streaming disabled', () => {
    const entry = findSpeechProviderCatalogEntry('deepgram-batch');
    expect(entry).toBeDefined();
    // Batch endpoint is synchronous, not streaming
    expect(entry!.streaming).toBe(false);
    expect(entry!.kind).toBe('stt');
  });

  it('should mark nvidia-nemo as unavailable (planned but not implemented)', () => {
    const entry = findSpeechProviderCatalogEntry('nvidia-nemo');
    expect(entry).toBeDefined();
    expect((entry as any).available).toBe(false);
  });

  it('should mark coqui as unavailable (planned but not implemented)', () => {
    const entry = findSpeechProviderCatalogEntry('coqui');
    expect((entry as any).available).toBe(false);
  });

  it('should mark bark as unavailable (planned but not implemented)', () => {
    const entry = findSpeechProviderCatalogEntry('bark');
    expect((entry as any).available).toBe(false);
  });

  it('should mark styletts2 as unavailable (planned but not implemented)', () => {
    const entry = findSpeechProviderCatalogEntry('styletts2');
    expect((entry as any).available).toBe(false);
  });

  it('should have azure-speech-stt with streaming disabled for the REST endpoint', () => {
    const entry = findSpeechProviderCatalogEntry('azure-speech-stt');
    // Azure REST API is batch-only; streaming requires the Speech SDK
    expect(entry!.streaming).toBe(false);
  });

  it('should have the openai-whisper entry as an STT provider', () => {
    const entry = findSpeechProviderCatalogEntry('openai-whisper');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('stt');
  });

  it('should default OpenAI transcription to gpt-transcribe', () => {
    // OpenAI removes whisper-1 on 2027-02-26 and names gpt-live-transcribe or
    // gpt-transcribe as the replacement; gpt-transcribe serves recorded files.
    expect(findSpeechProviderCatalogEntry('openai-whisper')!.defaultModel).toBe('gpt-transcribe');
  });

  it('should keep the OpenAI TTS default on a model /v1/audio/speech accepts', () => {
    // The speech endpoint's reference lists these models. OpenAI's named
    // replacement for them, gpt-realtime-2.1-mini, runs only on the Realtime
    // API, so a default pointing at it would fail every default synthesis.
    const speechEndpointModels = ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'];
    expect(speechEndpointModels).toContain(findSpeechProviderCatalogEntry('openai-tts')!.defaultModel);
  });
});
