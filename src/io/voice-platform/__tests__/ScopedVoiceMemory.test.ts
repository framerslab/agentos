import { describe, expect, it, vi } from 'vitest';
import { ScopedVoiceMemory, voiceSessionKey } from '../ScopedVoiceMemory.js';
import type { MemoryStore } from '../../../cognition/memory/retrieval/store/MemoryStore.js';
import type { MemoryTrace } from '../../../cognition/memory/core/types.js';
import { scopeFixture } from './VoiceScopeContext.test.js';
const trace: MemoryTrace = { id: 'memory-a', scope: 'thread', scopeId: 'call-a', type: 'episodic', content: 'neutral fixture', entities: [], tags: [],
  provenance: { sourceType: 'user_statement', sourceTimestamp: 1, confidence: 1, verificationCount: 0 },
  emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' }, encodingStrength: 1, stability: 1, retrievalCount: 0,
  lastAccessedAt: 1, accessCount: 0, reinforcementInterval: 1, associatedTraceIds: [], createdAt: 1, updatedAt: 1, isActive: true };
describe('call-scoped memory boundaries', () => {
  it('pins both writes and queries, rejects foreign identities and refuses a foreign result', async () => {
    const s = scopeFixture(); let stored: MemoryTrace | undefined;
    const store = vi.fn(async (t: MemoryTrace) => { stored = t; });
    const query = vi.fn<MemoryStore['query']>(async () => ({ scored: [], partial: [], timings: { vectorSearchMs: 0, scoringMs: 0 } }));
    const memory = new ScopedVoiceMemory(s, { store, query });
    await expect(memory.write({ scopeId: 'scope-b', callId: 'call-a' }, trace)).rejects.toThrow('scope'); expect(store).not.toHaveBeenCalled();
    await memory.write(s, trace); expect(stored!.scope).toBe('thread'); expect(stored!.scopeId).toBe(memory.namespace); expect(stored!.id).not.toBe(trace.id);
    await memory.query(s, 'fixture', { topK: 2 }); expect(query.mock.calls[0]![2]).toMatchObject({ scopes: [{ scope: 'thread', scopeId: memory.namespace }], topK: 2, hyde: false });
    await expect(memory.query({ scopeId: 'scope-a', callId: 'call-b' }, 'fixture')).rejects.toThrow('scope');
    query.mockResolvedValueOnce({ scored: [{ ...stored!, scopeId: 'foreign', retrievalScore: 1, scoreBreakdown: { strengthScore: 1, similarityScore: 1, recencyScore: 1, emotionalCongruenceScore: 1, graphActivationScore: 0, importanceScore: 1 } } as Awaited<ReturnType<MemoryStore['query']>>['scored'][number]], partial: [], timings: { vectorSearchMs: 0, scoringMs: 0 } });
    await expect(memory.query(s, 'fixture')).rejects.toThrow('memory boundary');
    expect(voiceSessionKey(s)).toBe(`session:${memory.namespace}`);
    expect(() => voiceSessionKey(s, { scopeId: 'scope-b', callId: 'call-a' })).toThrow('scope');
  });
  it('validates authority even when disabled and rejects widened options and links', async () => {
    const s = scopeFixture(); const memory = new ScopedVoiceMemory(s);
    await expect(memory.query({ scopeId: '', callId: '' }, 'fixture')).rejects.toThrow('scope');
    expect(await memory.query(s, 'fixture')).toEqual([]);
    await expect(memory.query(s, 'fixture', { scopes: [] } as never)).rejects.toThrow();
    await expect(memory.write(s, { ...trace, associatedTraceIds: ['foreign'] })).rejects.toThrow();
    await expect(memory.write(s, trace)).rejects.toThrow('disabled');
  });
});
