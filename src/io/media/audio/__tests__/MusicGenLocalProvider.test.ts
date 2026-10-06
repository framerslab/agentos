/**
 * @module media/audio/__tests__/MusicGenLocalProvider.test
 *
 * Unit tests for {@link MusicGenLocalProvider} (local MusicGen via HuggingFace).
 *
 * Mocks the dynamic `import('@huggingface/transformers')` to simulate the
 * pipeline loading and inference without requiring the actual library.
 *
 * ## What is tested
 *
 * - Music generation calls pipeline with correct prompt and max_new_tokens
 * - supports() returns true for music, false for sfx
 * - Missing @huggingface/transformers throws helpful error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MusicGenLocalProvider } from '../providers/MusicGenLocalProvider.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MusicGenLocalProvider', () => {
  let provider: MusicGenLocalProvider;

  beforeEach(() => {
    provider = new MusicGenLocalProvider();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Music generation
  // -------------------------------------------------------------------------

  it('should generate music by calling the pipeline with correct params', async () => {
    await provider.initialize({ modelId: 'Xenova/musicgen-small' });

    // Create fake audio output from the pipeline
    const fakeSamples = new Float32Array(1600);
    for (let i = 0; i < fakeSamples.length; i++) {
      fakeSamples[i] = Math.sin(i * 0.1) * 0.5;
    }

    const mockPipeline = vi.fn().mockResolvedValue({
      audio: fakeSamples,
      sampling_rate: 32000,
    });

    // Mock the dynamic import of @huggingface/transformers
    vi.spyOn(
      provider as unknown as { _ensurePipeline: () => Promise<unknown> },
      '_ensurePipeline',
    ).mockResolvedValue(mockPipeline);

    const result = await provider.generateMusic({
      prompt: 'Calm ambient pad',
      durationSec: 10,
    });

    expect(result.audio).toHaveLength(1);
    expect(result.audio[0].mimeType).toBe('audio/wav');
    expect(result.audio[0].base64).toBeDefined();
    expect(result.providerId).toBe('musicgen-local');
    expect(result.modelId).toBe('Xenova/musicgen-small');

    // Verify pipeline was called with correct args
    expect(mockPipeline).toHaveBeenCalledWith('Calm ambient pad', {
      max_new_tokens: 500, // 10 seconds * 50 tokens/sec
    });
  });

  // -------------------------------------------------------------------------
  // supports()
  // -------------------------------------------------------------------------

  it('should support music but not sfx', () => {
    expect(provider.supports('music')).toBe(true);
    expect(provider.supports('sfx')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Missing dependency
  // -------------------------------------------------------------------------

  it('should throw helpful error when @huggingface/transformers is not installed', async () => {
    await provider.initialize({});

    // The real _ensurePipeline does dynamic import which will fail in test env
    await expect(
      provider.generateMusic({ prompt: 'test' }),
    ).rejects.toThrow(/@huggingface\/transformers/);
  });
});
