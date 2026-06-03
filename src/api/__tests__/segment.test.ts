import { describe, it, expect, beforeEach } from 'vitest';
import { segment } from '../segment.js';
import {
  registerSegmentationProvider,
  resetSegmentationProviders,
} from '../../io/segmentation/SegmentationProviderRegistry.js';
import { SegmentationModeNotSupportedError, InvalidSegmentationPromptError } from '../../io/segmentation/errors.js';
import type { ISegmentationProvider, SegmentationRequest } from '../../io/segmentation/types.js';

function makeFake(modes: Array<'text' | 'points' | 'box' | 'automatic'>) {
  const calls: SegmentationRequest[] = [];
  const provider: ISegmentationProvider = {
    providerId: 'fake', isInitialized: true, defaultModelId: 'fake/model',
    async initialize() {},
    supportedModes() { return modes; },
    async segment(req) {
      calls.push(req);
      return { masks: [], width: 1, height: 1, providerId: 'fake', modelId: req.modelId, promptMode: req.mode, durationMs: 0 };
    },
  };
  return { provider, calls };
}

const img = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic (imageToBuffer passes Buffers through)

describe('segment()', () => {
  beforeEach(() => resetSegmentationProviders());

  it('normalizes options into a provider request (point label defaults to foreground)', async () => {
    const { provider, calls } = makeFake(['points', 'box', 'text', 'automatic']);
    registerSegmentationProvider('fake', provider);

    await segment({ image: img, provider: 'fake', points: [{ x: 3, y: 4 }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe('points');
    expect(calls[0].points).toEqual([{ x: 3, y: 4, label: 'foreground' }]);
    expect(Buffer.isBuffer(calls[0].image)).toBe(true);
  });

  it('throws SegmentationModeNotSupportedError before calling the provider', async () => {
    const { provider, calls } = makeFake(['box']);
    registerSegmentationProvider('fake', provider);
    await expect(segment({ image: img, provider: 'fake', prompt: 'chair' }))
      .rejects.toBeInstanceOf(SegmentationModeNotSupportedError);
    expect(calls).toHaveLength(0);
  });

  it('throws InvalidSegmentationPromptError when no mode is set', async () => {
    const { provider } = makeFake(['box']);
    registerSegmentationProvider('fake', provider);
    await expect(segment({ image: img, provider: 'fake' }))
      .rejects.toBeInstanceOf(InvalidSegmentationPromptError);
  });

  it('returns the provider result (empty masks is not an error)', async () => {
    const { provider } = makeFake(['automatic']);
    registerSegmentationProvider('fake', provider);
    const result = await segment({ image: img, provider: 'fake', automatic: true });
    expect(result.masks).toEqual([]);
  });
});
