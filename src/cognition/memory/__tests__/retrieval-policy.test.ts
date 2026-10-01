import { describe, expect, it, vi } from 'vitest';

import { AgentMemory } from '../AgentMemory.js';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';

describe('memory retrieval policy', () => {
  it('AgentMemory forwards policy to cognitive retrieval', async () => {
    const manager = {
      initialize: vi.fn(),
      retrieve: vi.fn().mockResolvedValue({
        retrieved: [],
        partiallyRetrieved: [],
        diagnostics: {
          candidatesScanned: 0,
          vectorSearchTimeMs: 0,
          scoringTimeMs: 0,
          totalTimeMs: 0,
        },
      }),
    } as unknown as CognitiveMemoryManager;

    const memory = AgentMemory.wrap(manager);
    await memory.recall('ship date', {
      policy: { profile: 'max-recall', adaptive: false },
    });

    expect((manager.retrieve as any)).toHaveBeenCalledWith(
      'ship date',
      expect.any(Object),
      expect.objectContaining({
        policy: expect.objectContaining({ profile: 'max-recall', adaptive: false }),
      }),
    );
  });

  it('suppresses weak cognitive hits when policy minScore is not met', async () => {
    const manager = new CognitiveMemoryManager();
    (manager as any).initialized = true;
    (manager as any).lifecycleState = 'initialized';
    (manager as any).store = {
      query: vi.fn().mockResolvedValue({
        scored: [
          {
            id: 't1',
            content: 'weak hit',
            retrievalScore: 0.12,
            scoreBreakdown: {
              strengthScore: 0.2,
              similarityScore: 0.1,
              recencyScore: 0.2,
              emotionalCongruenceScore: 0,
              graphActivationScore: 0,
              importanceScore: 0.2,
            },
          },
        ],
        partial: [],
        timings: { vectorSearchMs: 0, scoringMs: 0 },
      }),
      recordAccess: vi.fn(),
    };
    (manager as any).workingMemory = {
      focus: vi.fn(),
      decayActivations: vi.fn(),
    };

    const result = await manager.retrieve(
      'what ships friday',
      { valence: 0, arousal: 0, dominance: 0 },
      { policy: { profile: 'balanced', minScore: 0.3 } } as any,
    );

    expect(result.retrieved).toEqual([]);
    expect((result.diagnostics as any).suppressed).toBe('weak_hits');
    expect((result.diagnostics as any).confidence?.reason).toBe('weak_hits');
  });
});
