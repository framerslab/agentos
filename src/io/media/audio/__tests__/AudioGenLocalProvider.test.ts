/**
 * @module media/audio/__tests__/AudioGenLocalProvider.test
 *
 * Unit tests for {@link AudioGenLocalProvider} (local AudioGen via HuggingFace).
 *
 * Mocks the dynamic `import('@huggingface/transformers')` to simulate the
 * pipeline loading and inference without requiring the actual library.
 *
 * ## What is tested
 *
 * - SFX generation calls pipeline with correct prompt and max_new_tokens
 * - supports() returns true for sfx, false for music
 * - Missing @huggingface/transformers throws helpful error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioGenLocalProvider } from '../providers/AudioGenLocalProvider.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudioGenLocalProvider', () => {
  let provider: AudioGenLocalProvider;

  beforeEach(() => {
    provider = new AudioGenLocalProvider();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // SFX generation
  // -------------------------------------------------------------------------

  it('should generate SFX by calling the pipeline with correct params', async () => {
    await provider.initialize({ modelId: 'Xenova/audiogen-medium' });

    // Create fake audio output from the pipeline
    const fakeSamples = new Float32Array(800);
    for (let i = 0; i < fakeSamples.length; i++) {
      fakeSamples[i] = Math.sin(i * 0.2) * 0.3;
    }

    const mockPipeline = vi.fn().mockResolvedValue({
      audio: fakeSamples,
      sampling_rate: 16000,
    });

    // Mock the dynamic import of @huggingface/transformers
    vi.spyOn(
      provider as unknown as { _ensurePipeline: () => Promise<unknown> },
      '_ensurePipeline',
    ).mockResolvedValue(mockPipeline);

    const result = await provider.generateSFX({
      prompt: 'Dog barking in a park',
      durationSec: 5,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].mimeType).toBe('audio/wav');
    expect(result.audio[0].base64).toBeDefined();
    expect(result.providerId).toBe('audiogen-local');
    expect(result.modelId).toBe('Xenova/audiogen-medium');

    // Verify pipeline was called with correct args
    expect(mockPipeline).toHaveBeenCalledWith('Dog barking in a park', {
      max_new_tokens: 250, // 5 seconds * 50 tokens/sec
    });
  });

  // -------------------------------------------------------------------------
  // supports()
  // -------------------------------------------------------------------------

  it('should support sfx but not music', () => {
    expect(provider.supports('sfx')).toBe(true);
    expect(provider.supports('music')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Missing dependency
  // -------------------------------------------------------------------------

  it('should throw helpful error when @huggingface/transformers is not installed', async () => {
    await provider.initialize({});

    // The real _ensurePipeline does dynamic import which will fail in test env
    await expect(
      provider.generateSFX({ prompt: 'test' }),
    ).rejects.toThrow(/@huggingface\/transformers/);
  });
});
