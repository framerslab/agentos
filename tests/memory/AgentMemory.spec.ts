import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { AgentMemory } from '../../src/cognition/memory/AgentMemory.js';
import type { MemoryTrace } from '../../src/cognition/memory/core/types.js';

function createManager(overrides: Record<string, unknown> = {}) {
  return {
    initialize: vi.fn(async () => undefined),
    encode: vi.fn(async () => ({ id: 'trace-1', content: 'hello memory' })),
    retrieve: vi.fn(async () => ({
      retrieved: [{ id: 'trace-1', content: 'hello memory', retrievalScore: 0.92 }],
      partiallyRetrieved: [],
      diagnostics: { totalCandidates: 1 },
    })),
    observe: vi.fn(async () => [{ content: 'note-1' }]),
    assembleForPrompt: vi.fn(async () => ({ prompt: 'context block', includedMemoryIds: ['trace-1'] })),
    registerProspective: vi.fn(async (input) => ({ id: 'pm-1', ...input })),
    listProspective: vi.fn(async () => [{ id: 'pm-1', content: 'follow up' }]),
    runConsolidation: vi.fn(async () => undefined),
    getMemoryHealth: vi.fn(async () => ({ status: 'ok' })),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

function createTrace(overrides: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    id: 'trace-1',
    type: 'episodic',
    scope: 'thread',
    scopeId: 'thread-1',
    content: 'hello memory',
    entities: [],
    tags: ['prefs'],
    provenance: {
      sourceType: 'user_statement',
      sourceTimestamp: Date.now(),
      confidence: 1,
      verificationCount: 0,
    },
    emotionalContext: {
      valence: 0,
      arousal: 0,
      dominance: 0,
      intensity: 0,
      gmiMood: 'neutral',
    },
    encodingStrength: 0.8,
    stability: 86_400_000,
    retrievalCount: 0,
    lastAccessedAt: Date.now(),
    accessCount: 0,
    reinforcementInterval: 86_400_000,
    associatedTraceIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isActive: true,
    ...overrides,
  };
}

function createStandaloneMemory(overrides: Record<string, unknown> = {}) {
  const trace = createTrace();
  return {
    remember: vi.fn(async () => trace),
    recall: vi.fn(async () => [{ trace, score: 0.92 }]),
    consolidate: vi.fn(async () => ({
      pruned: 0,
      merged: 0,
      derived: 0,
      compacted: 0,
      durationMs: 5,
    })),
    health: vi.fn(async () => ({
      totalTraces: 1,
      activeTraces: 1,
      avgStrength: 0.8,
      weakestTraceStrength: 0.8,
      graphNodes: 0,
      graphEdges: 0,
      lastConsolidation: null,
      tracesPerType: { episodic: 1 },
      tracesPerScope: { thread: 1 },
      documentsIngested: 0,
    })),
    close: vi.fn(async () => undefined),
    ingest: vi.fn(async () => ({
      succeeded: ['doc.md'],
      failed: [],
      chunksCreated: 1,
      tracesCreated: 1,
    })),
    importFrom: vi.fn(async () => ({
      imported: 1,
      skipped: 0,
      errors: [],
    })),
    export: vi.fn(async () => undefined),
    feedback: vi.fn(),
    ...overrides,
  } as any;
}

describe('AgentMemory', () => {
  it('wrap() marks an existing manager as initialized and exposes raw', () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    expect(memory.isInitialized).toBe(true);
    expect(memory.raw).toBe(manager);
  });

  it('initialize() delegates once and becomes ready', async () => {
    const manager = createManager();
    const memory = new AgentMemory(manager);

    await memory.initialize({} as any);
    await memory.initialize({} as any);

    expect(manager.initialize).toHaveBeenCalledTimes(1);
    expect(memory.isInitialized).toBe(true);
  });

  it('throws from public methods when not initialized', async () => {
    const memory = new AgentMemory(createManager());

    await expect(memory.recall('preferences')).rejects.toThrow('AgentMemory not initialized');
  });

  it('remember() delegates with neutral mood defaults', async () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    const result = await memory.remember('User prefers dark mode', { tags: ['prefs'] });

    expect(result.success).toBe(true);
    expect(manager.encode).toHaveBeenCalledWith(
      'User prefers dark mode',
      { valence: 0, arousal: 0, dominance: 0 },
      'neutral',
      expect.objectContaining({
        type: 'episodic',
        scope: 'thread',
        sourceType: 'user_statement',
        tags: ['prefs'],
      }),
    );
  });

  it('remember() accepts relational traces for companion state and trust events', async () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    const result = await memory.remember('Companion trust increased after defending the player', {
      type: 'relational',
      tags: ['companions', 'trust'],
      sourceType: 'observation',
    });

    expect(result.success).toBe(true);
    expect(manager.encode).toHaveBeenCalledWith(
      'Companion trust increased after defending the player',
      { valence: 0, arousal: 0, dominance: 0 },
      'neutral',
      expect.objectContaining({
        type: 'relational',
        sourceType: 'observation',
        tags: ['companions', 'trust'],
      }),
    );
  });

  it('remember() returns success false when encoding fails', async () => {
    const manager = createManager({
      encode: vi.fn(async () => {
        throw new Error('encoding failed');
      }),
    });
    const memory = AgentMemory.wrap(manager);

    const result = await memory.remember('broken');

    expect(result.success).toBe(false);
  });

  it('recall() and search() delegate to retrieve()', async () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    const recall = await memory.recall('dark mode', { limit: 5, tags: ['prefs'] });
    const search = await memory.search('dark mode', { limit: 5 });

    expect(recall.memories).toHaveLength(1);
    expect(search).toHaveLength(1);
    expect(manager.retrieve).toHaveBeenCalledWith(
      'dark mode',
      { valence: 0, arousal: 0, dominance: 0 },
      expect.objectContaining({ topK: 5 }),
    );
  });

  it('observe(), remind(), reminders(), consolidate(), and health() delegate cleanly', async () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    const notes = await memory.observe('user', 'Can you help with TMJ?');
    const reminder = await memory.remind({
      content: 'Follow up',
      triggerType: 'time',
      triggerAt: Date.now() + 60_000,
      metadata: {},
      importance: 0.7,
    } as any);
    const reminders = await memory.reminders();
    await memory.consolidate();
    const health = await memory.health();

    expect(notes).toEqual([{ content: 'note-1' }]);
    expect(reminder?.id).toBe('pm-1');
    expect(reminders).toHaveLength(1);
    expect(manager.runConsolidation).toHaveBeenCalledTimes(1);
    expect(health).toEqual({ status: 'ok' });
  });

  it('falls back gracefully when optional manager methods are unavailable', async () => {
    const manager = createManager({
      observe: undefined,
      registerProspective: undefined,
      listProspective: undefined,
      runConsolidation: undefined,
    });
    const memory = AgentMemory.wrap(manager);

    await expect(memory.observe('user', 'hello')).resolves.toBeNull();
    await expect(memory.remind({ content: 'later' } as any)).resolves.toBeNull();
    await expect(memory.reminders()).resolves.toEqual([]);
    await expect(memory.consolidate()).resolves.toBeUndefined();
  });

  it('shutdown() delegates and resets initialization state', async () => {
    const manager = createManager();
    const memory = AgentMemory.wrap(manager);

    await memory.shutdown();

    expect(manager.shutdown).toHaveBeenCalledTimes(1);
    expect(memory.isInitialized).toBe(false);
  });

  it('wrapMemory() marks a standalone memory facade as initialized and exposes rawMemory', async () => {
    const standalone = createStandaloneMemory();
    const memory = AgentMemory.wrapMemory(standalone);

    expect(memory.isInitialized).toBe(true);
    expect(memory.rawMemory).toBe(standalone);
    await expect(memory.remember('User prefers dark mode')).resolves.toMatchObject({
      success: true,
      trace: expect.objectContaining({ id: 'trace-1' }),
    });
  });

  it('delegates recall, health, ingest, export, import, feedback, and shutdown to standalone memory', async () => {
    const standalone = createStandaloneMemory();
    const memory = AgentMemory.wrapMemory(standalone);

    const recall = await memory.recall('dark mode', {
      limit: 5,
      types: ['episodic'],
      tags: ['prefs'],
      minConfidence: 0.5,
    });
    const search = await memory.search('dark mode');
    const health = await memory.health();
    const ingest = await memory.ingest('./docs');
    await memory.export('./backup.json', { format: 'json' });
    const imported = await memory.importFrom('./backup.json', { format: 'json' });
    memory.feedback('trace-1', 'used', 'dark mode');
    await memory.shutdown();

    expect(recall.memories).toHaveLength(1);
    expect(recall.memories[0]?.retrievalScore).toBe(0.92);
    expect(search).toHaveLength(1);
    expect(health.totalTraces).toBe(1);
    expect(health.tracesPerType.episodic).toBe(1);
    expect(ingest.tracesCreated).toBe(1);
    expect(imported.imported).toBe(1);
    expect(standalone.recall).toHaveBeenCalledWith('dark mode', expect.objectContaining({ limit: 50, type: 'episodic' }));
    expect(standalone.ingest).toHaveBeenCalledWith('./docs', undefined);
    expect(standalone.export).toHaveBeenCalledWith('./backup.json', { format: 'json' });
    expect(standalone.importFrom).toHaveBeenCalledWith('./backup.json', { format: 'json' });
    expect(standalone.feedback).toHaveBeenCalledWith('trace-1', 'used', 'dark mode');
    expect(standalone.close).toHaveBeenCalledTimes(1);
    expect(memory.isInitialized).toBe(false);
  });

  it('does not reopen a standalone backend after shutdown', async () => {
    const standalone = createStandaloneMemory();
    const memory = AgentMemory.wrapMemory(standalone);

    await memory.shutdown();

    await expect(memory.initialize({} as any)).rejects.toThrow(
      'cannot reopen a closed standalone memory backend',
    );
    expect(memory.isInitialized).toBe(false);
    await expect(memory.remember('after shutdown')).rejects.toThrow(
      'AgentMemory not initialized',
    );
    expect(standalone.close).toHaveBeenCalledTimes(1);
  });

  it('throws a helpful error when cognitive-only APIs are used on standalone memory', async () => {
    const memory = AgentMemory.wrapMemory(createStandaloneMemory());

    await expect(memory.observe('user', 'hello')).rejects.toThrow(
      'AgentMemory.observe() requires a CognitiveMemoryManager-backed instance',
    );
    await expect(memory.getContext('hello')).rejects.toThrow(
      'AgentMemory.getContext() requires a CognitiveMemoryManager-backed instance',
    );
    await expect(memory.remind({ content: 'later' } as any)).rejects.toThrow(
      'AgentMemory.remind() requires a CognitiveMemoryManager-backed instance',
    );
    await expect(memory.reminders()).rejects.toThrow(
      'AgentMemory.reminders() requires a CognitiveMemoryManager-backed instance',
    );
    expect(() => memory.raw).toThrow(
      'AgentMemory.raw is only available when backed by CognitiveMemoryManager',
    );
  });

  it('throws a helpful error when standalone-only APIs are used on cognitive memory', async () => {
    const memory = AgentMemory.wrap(createManager());

    await expect(memory.ingest('./docs')).rejects.toThrow(
      'AgentMemory.ingest() requires the standalone SQLite-backed Memory facade',
    );
    await expect(memory.importFrom('./backup.json')).rejects.toThrow(
      'AgentMemory.importFrom() requires the standalone SQLite-backed Memory facade',
    );
    await expect(memory.export('./backup.json')).rejects.toThrow(
      'AgentMemory.export() requires the standalone SQLite-backed Memory facade',
    );
    expect(() => memory.feedback('trace-1', 'used')).toThrow(
      'AgentMemory.feedback() requires the standalone SQLite-backed Memory facade',
    );
  });

  it('sqlite() provides a ready standalone adapter over the new Memory facade', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-'));
    const brainPath = path.join(tempDir, 'brain.sqlite');
    const memory = await AgentMemory.sqlite({
      path: brainPath,
      graph: false,
      selfImprove: false,
    });

    try {
      expect(memory.isInitialized).toBe(true);
      expect(memory.rawMemory).toBeDefined();

      await memory.remember('User prefers dark mode', { tags: ['prefs'] });
      const recall = await memory.recall('dark mode');
      const health = await memory.health();

      expect(recall.memories).toHaveLength(1);
      expect(recall.memories[0]?.content).toContain('dark mode');
      expect(health.totalTraces).toBe(1);
      expect(health.tracesPerScope.thread).toBe(1);
    } finally {
      await memory.shutdown();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
