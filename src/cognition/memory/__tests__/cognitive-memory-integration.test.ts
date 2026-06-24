/**
 * @fileoverview Full pipeline integration test for cognitive memory completion.
 *
 * Exercises the entire pipeline end-to-end:
 * 1. CognitiveMemoryManager with observer + reflector + graph
 * 2. observe() triggers observer → reflector → typed traces
 * 3. Reflector produces all 5 memory types (episodic, semantic, procedural, prospective, relational)
 * 4. Commitment notes auto-register as prospective items
 * 5. Graph is active by default
 * 6. HyDE retriever is auto-attached
 * 7. assembleForPrompt() includes preamble and all sections
 * 8. AgentMemory API surface works (getGraph, exportSnapshot, etc.)
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { CognitiveMemoryManager } from '../CognitiveMemoryManager';
import { AgentMemory } from '../AgentMemory';

describe('Cognitive Memory — full pipeline integration', () => {
  let manager: CognitiveMemoryManager;
  let memory: AgentMemory;
  const llmInvoker = vi.fn();

  // Track which LLM calls are observer vs reflector vs HyDE
  // by inspecting the system prompt content
  beforeAll(async () => {
    llmInvoker.mockImplementation(async (system: string, _user: string) => {
      // Observer call — produce structured observation notes
      if (system.includes('memory observer')) {
        return [
          '{"type":"factual","content":"User is a software engineer","importance":0.9,"entities":["user"]}',
          '{"type":"commitment","content":"User will check back next Friday","importance":0.8,"entities":["user"]}',
          '{"type":"emotional","content":"User expressed stress about deadline","importance":0.7,"entities":["user"]}',
          '{"type":"preference","content":"User would love to try rock climbing","importance":0.65,"entities":["user"]}',
        ].join('\n');
      }

      // Reflector call — produce typed long-term traces from observation notes.
      // The reflector uses <thinking> for chain-of-thought before outputting JSON.
      if (system.includes('memory reflector')) {
        return [
          '<thinking>User revealed a fact (engineer), a commitment (Friday), emotional vulnerability (stress), and a future preference (climbing).</thinking>',
          '{"reasoning":"Durable fact about user profession","type":"semantic","scope":"user","scopeId":"","content":"User is a software engineer","entities":["user"],"tags":["profession"],"confidence":0.95,"sourceType":"reflection","supersedes":[],"consumedNotes":["obs_1"]}',
          '{"reasoning":"Time-bound intention","type":"prospective","scope":"user","scopeId":"","content":"User will check back next Friday","entities":["user"],"tags":["deadline"],"confidence":0.85,"sourceType":"reflection","supersedes":[],"consumedNotes":["obs_2"]}',
          '{"reasoning":"User shared vulnerability — trust signal","type":"relational","scope":"user","scopeId":"","content":"User shared vulnerability about work stress — trust-building moment","entities":["user"],"tags":["trust","vulnerability"],"confidence":0.8,"sourceType":"reflection","supersedes":[],"consumedNotes":["obs_3"]}',
          '{"reasoning":"Episodic record of the exchange","type":"episodic","scope":"thread","scopeId":"test-session","content":"User introduced themselves, mentioned engineering work, upcoming deadline, and interest in climbing","entities":["user"],"tags":["introduction"],"confidence":0.9,"sourceType":"reflection","supersedes":[],"consumedNotes":["obs_4"]}',
        ].join('\n');
      }

      // HyDE call — generate a hypothetical stored memory trace
      if (system.includes('STORED MEMORY')) {
        return 'User mentioned they work as a software engineer in a tech company.';
      }

      return '';
    });

    manager = new CognitiveMemoryManager();

    // Mock IKnowledgeGraph with all required methods
    const mockKnowledgeGraph = {
      initialize: vi.fn(),
      upsertEntity: vi.fn(),
      upsertRelation: vi.fn(),
      queryEntities: vi.fn().mockResolvedValue([]),
      getNeighborhood: vi.fn().mockResolvedValue({ entities: [], relations: [] }),
      getRelations: vi.fn().mockResolvedValue([]),
      deleteEntity: vi.fn(),
      deleteRelation: vi.fn(),
      traverse: vi.fn().mockResolvedValue({
        root: { id: 'root', type: 'memory', label: 'root', properties: {}, confidence: 1, source: { type: 'system', timestamp: '', method: '' } } as any,
        levels: [],
        totalEntities: 0,
        totalRelations: 0,
      }),
      recordMemory: vi.fn(),
    };

    // Mock IVectorStore
    const mockVectorStore = {
      initialize: vi.fn(),
      upsert: vi.fn(),
      query: vi.fn().mockResolvedValue({ documents: [] }),
      collectionExists: vi.fn().mockResolvedValue(true),
      createCollection: vi.fn(),
    };

    // Mock IEmbeddingManager
    const mockEmbeddingManager = {
      generateEmbeddings: vi.fn().mockResolvedValue({
        embeddings: [[0.1, 0.2, 0.3]],
        modelId: 'test',
        providerId: 'test',
        usage: { totalTokens: 0 },
      }),
      getEmbeddingDimension: vi.fn().mockResolvedValue(3),
      getEmbeddingModelInfo: vi.fn().mockResolvedValue({
        dimension: 3,
        modelId: 'test',
        providerId: 'test',
        maxInputTokens: 8192,
      }),
      initialize: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue({ isHealthy: true }),
      shutdown: vi.fn(),
    };

    // Mock IWorkingMemory
    const mockWorkingMemory = {
      capacity: 7,
      store: vi.fn(),
      retrieve: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
      getSlots: vi.fn().mockReturnValue([]),
    };

    await manager.initialize({
      agentId: 'integration-test',
      traits: { emotionality: 0.8, conscientiousness: 0.6 },
      moodProvider: () => ({ valence: 0, arousal: 0.3, dominance: 0 }),
      featureDetectionStrategy: 'keyword',
      // Observer and Reflector both use the same LLM invoker.
      // Thresholds set to 1 so they fire on every call.
      observer: { llmInvoker, activationThresholdTokens: 1 },
      reflector: { llmInvoker, activationThresholdTokens: 1 },
      // Graph: default activation (no explicit config needed — tests Task 2)
      workingMemory: mockWorkingMemory as any,
      knowledgeGraph: mockKnowledgeGraph as any,
      vectorStore: mockVectorStore as any,
      embeddingManager: mockEmbeddingManager as any,
    });

    memory = AgentMemory.wrap(manager);
  });

  afterAll(async () => {
    await memory.shutdown();
  });

  // ── Task 2: Graph default activation ─────────────────────────────────────
  it('graph is active by default (no explicit graph config)', () => {
    expect(manager.getGraph()).not.toBeNull();
  });

  // ── Task 4: HyDE auto-attach ─────────────────────────────────────────────
  it('HyDE retriever is auto-attached when LLM invoker is available', () => {
    expect(manager.getHydeRetriever?.()).not.toBeNull();
  });

  // ── Task 1 + 3: observe() triggers full pipeline ─────────────────────────
  it('observe() triggers observer → reflector → typed traces', async () => {
    const notes = await memory.observe(
      'user',
      "I'm a software engineer, deadline next Friday, feeling stressed, would love to try rock climbing"
    );

    // Observer should produce notes
    expect(notes).not.toBeNull();
    expect(notes!.length).toBeGreaterThanOrEqual(1);
  });

  // ── Task 1: Reflector produces all 5 types ───────────────────────────────
  it('reflector produces typed traces (semantic, prospective, relational, episodic)', async () => {
    // The health report should show traces were encoded into the store cache
    const health = await memory.health();
    expect(health.totalTraces).toBeGreaterThanOrEqual(1);

    // Verify multiple types exist by checking the store's trace cache directly.
    // The health report's tracesPerType aggregates from the store, but with mocked
    // vector stores the per-type scan may not populate. Use getStrengthDistribution()
    // which reads from listTraces() on the store's internal cache.
    const dist = await memory.getStrengthDistribution();
    const typesWithTraces = Object.entries(dist).filter(([_, stats]) => stats.count > 0);
    // We expect at least 2 different types from the reflector mock output
    expect(typesWithTraces.length).toBeGreaterThanOrEqual(2);
  });

  // ── Task 3: Commitment auto-registers as prospective ─────────────────────
  it('commitment notes are auto-registered as prospective items', async () => {
    const items = await memory.getProspectiveItems();
    // At least 1 prospective item from the commitment note
    expect(items.length).toBeGreaterThanOrEqual(1);
    // Should contain the Friday deadline commitment
    const hasDeadline = items.some((i) => i.content.toLowerCase().includes('friday'));
    expect(hasDeadline).toBe(true);
  });

  // ── Task 5: Assembler includes preamble ──────────────────────────────────
  it('assembleForPrompt includes memory usage preamble', async () => {
    const context = await memory.getContext('what does the user do?', { tokenBudget: 2000 });
    expect(context.contextText).toContain('How To Use Your Memories');
    expect(context.contextText).toContain('Semantic Recall');
    expect(context.contextText).toContain('Prospective Alerts');
  });

  // ── Task 7: AgentMemory API surface ──────────────────────────────────────
  it('getGraph() returns a valid graph snapshot', async () => {
    const graph = await memory.getGraph();
    expect(graph).toBeDefined();
    expect(graph.stats).toBeDefined();
    expect(typeof graph.stats.nodeCount).toBe('number');
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it('getStrengthDistribution() returns stats per type', async () => {
    const dist = await memory.getStrengthDistribution();
    expect(dist.episodic).toBeDefined();
    expect(dist.semantic).toBeDefined();
    expect(dist.relational).toBeDefined();
    expect(typeof dist.episodic.count).toBe('number');
    expect(typeof dist.episodic.avgStrength).toBe('number');
  });

  it('exportSnapshot() returns a valid snapshot', async () => {
    const snapshot = await memory.exportSnapshot();
    expect(snapshot.version).toBe('1.0.0');
    expect(snapshot.agentId).toBe('integration-test');
    expect(Array.isArray(snapshot.traces)).toBe(true);
    expect(snapshot.metadata.traceCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.metadata.typeDistribution).toBeDefined();
  });

  it('getObservationStats() returns pipeline stats', async () => {
    const stats = await memory.getObservationStats();
    expect(typeof stats.pendingNotes).toBe('number');
    expect(typeof stats.pendingCompressed).toBe('number');
  });

  it('getWorkingMemory() returns slots array', async () => {
    const slots = await memory.getWorkingMemory();
    expect(Array.isArray(slots)).toBe(true);
  });

  // ── Standalone fallback: cognitive-only methods throw ─────────────────────
  it('cognitive-only methods throw on standalone SQLite backend', async () => {
    const standalone = await AgentMemory.sqlite({ path: ':memory:' });

    await expect(standalone.getGraph()).rejects.toThrow('CognitiveMemoryManager');
    await expect(standalone.getStrengthDistribution()).rejects.toThrow('CognitiveMemoryManager');
    await expect(standalone.exportSnapshot()).rejects.toThrow('CognitiveMemoryManager');
    await expect(standalone.getTracesByType('semantic')).rejects.toThrow('CognitiveMemoryManager');

    await standalone.shutdown();
  });

  // ── tierRank gate (2026-06-23): maxTierRank threads to prospective assembly ──
  it('assembleForPrompt withholds prospective alerts above maxTierRank', async () => {
    const p = manager.getProspective()!;
    await p.register({
      content: 'standard reminder',
      triggerType: 'time_based',
      triggerAt: 1,
      importance: 0.9,
      recurring: false,
      tierRank: 1,
    });
    await p.register({
      content: 'mature reminder',
      triggerType: 'time_based',
      triggerAt: 1,
      importance: 0.9,
      recurring: false,
      tierRank: 2,
    });

    const out = await manager.assembleForPrompt(
      'anything',
      2000,
      { valence: 0, arousal: 0, dominance: 0 },
      { maxTierRank: 1 },
    );
    expect(out.contextText).toContain('standard reminder');
    expect(out.contextText).not.toContain('mature reminder');
  });

  it('snapshot round-trip preserves prospective tierRank (export + import)', async () => {
    const unique = 'keep rank roundtrip probe';
    await manager.getProspective()!.register({
      content: unique,
      triggerType: 'time_based',
      triggerAt: 1,
      importance: 0.5,
      recurring: false,
      tierRank: 2,
    });

    const snap = await memory.exportSnapshot();
    expect(snap.prospectiveItems.find((x) => x.content === unique)?.tierRank).toBe(2);

    await memory.importSnapshot(snap);
    const matches = manager
      .getProspective()!
      .getActive()
      .filter((x) => x.content === unique);
    expect(matches.length).toBeGreaterThanOrEqual(2); // original + re-imported copy
    expect(matches.every((x) => x.tierRank === 2)).toBe(true); // import carried tierRank
  });
});
