import { describe, it, expect, vi } from 'vitest';
import { AgentMemory } from '../AgentMemory.js';

/**
 * Build an AgentMemory whose private `manager` is a spy object so we can assert
 * the exact call shape AgentMemory forwards. Mirrors the private-field
 * injection pattern used across the memory __tests__ suite.
 */
function cognitiveMemoryWithManagerSpy() {
  const mem = Object.create(AgentMemory.prototype) as AgentMemory;
  const manager = {
    observe: vi.fn().mockResolvedValue(null),
    retrieve: vi.fn().mockResolvedValue({ retrieved: [], partiallyRetrieved: [], diagnostics: {} }),
    assembleForPrompt: vi.fn().mockResolvedValue({ contextText: '', retrievedTraces: [] }),
    encode: vi.fn().mockResolvedValue({ id: 'x' }),
  };
  (mem as unknown as { manager: unknown }).manager = manager;
  (mem as unknown as { standalone: unknown }).standalone = undefined;
  (mem as unknown as { _initialized: boolean })._initialized = true;
  return { mem, manager };
}

describe('AgentMemory.observe mood args', () => {
  it('omitted args → NEUTRAL mood + no contentSentiment (byte-identical)', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.observe('user', 'hi');
    expect(manager.observe).toHaveBeenCalledWith('user', 'hi', { valence: 0, arousal: 0, dominance: 0 }, { contentSentiment: undefined });
  });

  it('supplied args pass through verbatim', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.observe('user', 'hi', { currentMood: { valence: 0.6, arousal: 0.4, dominance: 0.1 }, contentSentiment: 0.7 });
    expect(manager.observe).toHaveBeenCalledWith('user', 'hi', { valence: 0.6, arousal: 0.4, dominance: 0.1 }, { contentSentiment: 0.7 });
  });
});

describe('AgentMemory.recall mood arg', () => {
  it('omitted → NEUTRAL passed to manager.retrieve', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.recall('q');
    expect(manager.retrieve).toHaveBeenCalledWith('q', { valence: 0, arousal: 0, dominance: 0 }, expect.any(Object));
  });
  it('supplied currentMood passes through', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.recall('q', { currentMood: { valence: -0.5, arousal: 0.3, dominance: 0 } });
    expect(manager.retrieve).toHaveBeenCalledWith('q', { valence: -0.5, arousal: 0.3, dominance: 0 }, expect.any(Object));
  });
});

describe('AgentMemory.getContext mood arg', () => {
  it('omitted → NEUTRAL passed to assembleForPrompt', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.getContext('q', { tokenBudget: 1000 });
    expect(manager.assembleForPrompt).toHaveBeenCalledWith('q', 1000, { valence: 0, arousal: 0, dominance: 0 });
  });
  it('supplied currentMood passes through; default budget 2000 preserved', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.getContext('q', { currentMood: { valence: 0.4, arousal: 0.2, dominance: 0 } });
    expect(manager.assembleForPrompt).toHaveBeenCalledWith('q', 2000, { valence: 0.4, arousal: 0.2, dominance: 0 });
  });
});

describe('AgentMemory.remember mood arg', () => {
  it('omitted → NEUTRAL + gmiMood "neutral" + contentSentiment falls back to importance', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.remember('content', { importance: 0.5 });
    expect(manager.encode).toHaveBeenCalledWith('content', { valence: 0, arousal: 0, dominance: 0 }, 'neutral', expect.objectContaining({ contentSentiment: 0.5 }));
  });
  it('supplied currentMood + contentSentiment override', async () => {
    const { mem, manager } = cognitiveMemoryWithManagerSpy();
    await mem.remember('content', { importance: 0.5, currentMood: { valence: 0.3, arousal: 0.1, dominance: 0 }, contentSentiment: -0.2 });
    expect(manager.encode).toHaveBeenCalledWith('content', { valence: 0.3, arousal: 0.1, dominance: 0 }, 'neutral', expect.objectContaining({ contentSentiment: -0.2 }));
  });
});
