import { describe, it, expect, vi } from 'vitest';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager.js';
import type { MemoryObserver } from '../pipeline/observation/MemoryObserver.js';
import type { MemoryReflector } from '../pipeline/observation/MemoryReflector.js';

/**
 * Minimal observer/reflector stubs that drive observe() far enough to reach
 * encode(). Mirrors the private-field injection pattern from
 * CognitiveMemoryManager.flushReflection.test.ts (no-arg constructor +
 * `as unknown as {...}` field injection).
 */
function managerReachingEncode(): CognitiveMemoryManager {
  const mgr = new CognitiveMemoryManager();
  (mgr as unknown as { observer: MemoryObserver }).observer = {
    observe: vi.fn().mockResolvedValue([{ content: 'note' }]),
  } as unknown as MemoryObserver;
  (mgr as unknown as { reflector: MemoryReflector }).reflector = {
    addNotes: vi.fn().mockResolvedValue({
      traces: [
        {
          content: 't',
          type: 'episodic',
          scope: 'thread',
          scopeId: 's',
          provenance: { sourceType: 'user_statement' },
          tags: [],
          entities: [],
        },
      ],
      supersededTraceIds: [],
    }),
  } as unknown as MemoryReflector;
  return mgr;
}

describe('CognitiveMemoryManager.observe forwards contentSentiment', () => {
  it('passes options.contentSentiment into the encode() call for reflected traces', async () => {
    const mgr = managerReachingEncode();
    const encodeSpy = vi.spyOn(mgr, 'encode').mockResolvedValue({ id: 'x' } as never);

    await mgr.observe('user', 'I am thrilled', { valence: 0.8, arousal: 0.5, dominance: 0 }, { contentSentiment: 0.9 });

    expect(encodeSpy).toHaveBeenCalledWith(
      't',
      { valence: 0.8, arousal: 0.5, dominance: 0 },
      '',
      expect.objectContaining({ contentSentiment: 0.9 }),
    );
  });

  it('omitting options keeps encode contentSentiment undefined (byte-identical)', async () => {
    const mgr = managerReachingEncode();
    const encodeSpy = vi.spyOn(mgr, 'encode').mockResolvedValue({ id: 'x' } as never);

    await mgr.observe('user', 'hello'); // no mood, no options

    const [, mood, gmi, opts] = encodeSpy.mock.calls[0];
    expect(mood).toEqual({ valence: 0, arousal: 0, dominance: 0 });
    expect(gmi).toBe('');
    expect((opts as { contentSentiment?: number }).contentSentiment).toBeUndefined();
  });
});
