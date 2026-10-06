/**
 * @file GraphRAGEngine.test.ts
 * @description Tests for the TypeScript-native GraphRAG engine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock uuid to produce deterministic IDs that work with .slice(0, 8)
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `${(uuidCounter++).toString().padStart(8, '0')}`,
}));

// Mock graphology
const mockGraph = {
  addNode: vi.fn(),
  addEdge: vi.fn(),
  hasNode: vi.fn().mockReturnValue(false),
  neighbors: vi.fn().mockReturnValue([]),
  order: 0,
  size: 0,
};

vi.mock('graphology', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      // Reset order/size on each new Graph instance
      return { ...mockGraph, order: 0, size: 0 };
    }),
  };
});

// Mock louvain community detection
vi.mock('graphology-communities-louvain', () => ({
  default: vi.fn().mockReturnValue({}),
}));

import { GraphRAGEngine } from '../graphrag/GraphRAGEngine';
import type { IVectorStore } from '../IVectorStore';
import type { IEmbeddingManager } from '../IEmbeddingManager';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockVectorStore(): IVectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue({ upsertedCount: 1, upsertedIds: [], failedCount: 0 }),
    query: vi.fn().mockResolvedValue({ documents: [], queryId: 'q-1' }),
    delete: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true, details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    createCollection: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(false),
  } as unknown as IVectorStore;
}

function createMockEmbeddingManager(): IEmbeddingManager {
  return {
    generateEmbeddings: vi.fn().mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      model: 'test-model',
      usage: { totalTokens: 10 },
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEmbeddingManager;
}

function createMockLLMProvider() {
  return {
    generateText: vi.fn().mockResolvedValue('Mock LLM response.'),
  };
}

function createMockPersistenceAdapter() {
  return {
    exec: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    all: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('GraphRAGEngine', () => {
  let engine: GraphRAGEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  afterEach(async () => {
    if (engine) {
      try { await engine.shutdown(); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  describe('initialize', () => {
    it('should initialize successfully with minimal config', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'test-engine' });

      const stats = await engine.getStats();
      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelationships).toBe(0);
      expect(stats.totalCommunities).toBe(0);
      expect(stats.documentsIngested).toBe(0);
    });

    it('should initialize with all dependencies injected', async () => {
      const vectorStore = createMockVectorStore();
      const embeddingManager = createMockEmbeddingManager();
      const llmProvider = createMockLLMProvider();
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({
        vectorStore,
        embeddingManager,
        llmProvider,
        persistenceAdapter: persistence,
      });

      await engine.initialize({ engineId: 'full-engine' });

      // Should create persistence schema
      expect(persistence.exec).toHaveBeenCalled();
      // Should load from persistence
      expect(persistence.all).toHaveBeenCalled();
      // Should create vector store collections
      expect(vectorStore.collectionExists).toHaveBeenCalled();
    });

    it('should apply default config values', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'defaults' });

      const stats = await engine.getStats();
      expect(stats).toBeDefined();
    });

    it('should clear data on re-initialization', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'first' });
      await engine.initialize({ engineId: 'second' });

      const stats = await engine.getStats();
      expect(stats.totalEntities).toBe(0);
    });
  });

  // =========================================================================
  // Not Initialized Guard
  // =========================================================================

  describe('ensureInitialized', () => {
    it('should throw when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.getStats()).rejects.toThrow(/not initialized/i);
    });

    it('should throw on query when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.globalSearch('test')).rejects.toThrow(/not initialized/i);
    });

    it('should throw on localSearch when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.localSearch('test')).rejects.toThrow(/not initialized/i);
    });

    it('should throw on ingestDocuments when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.ingestDocuments([{ id: 'd1', content: 'test' }]))
        .rejects.toThrow(/not initialized/i);
    });

    it('should throw on getEntities when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.getEntities()).rejects.toThrow(/not initialized/i);
    });

    it('should throw on getRelationships when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.getRelationships('e1')).rejects.toThrow(/not initialized/i);
    });

    it('should throw on getCommunities when not initialized', async () => {
      engine = new GraphRAGEngine();
      await expect(engine.getCommunities()).rejects.toThrow(/not initialized/i);
    });
  });

  // =========================================================================
  // Pattern-Based Extraction (no LLM)
  // =========================================================================

  describe('ingestDocuments (pattern extraction)', () => {
    beforeEach(async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'pattern-test' });
    });

    it('should extract proper noun entities from text', async () => {
      const result = await engine.ingestDocuments([
        {
          id: 'doc-1',
          content: 'John Smith works at Acme Corporation in New York. Acme Corporation builds software.',
        },
      ]);

      expect(result.documentsProcessed).toBe(1);
      expect(result.entitiesExtracted).toBeGreaterThan(0);

      const entities = await engine.getEntities();
      const names = entities.map(e => e.name);
      expect(names).toContain('John Smith');
      expect(names).toContain('Acme Corporation');
      expect(names).toContain('New York');
    });

    it('should create relationships between entities in the same sentence', async () => {
      const result = await engine.ingestDocuments([
        {
          id: 'doc-1',
          content: 'John Smith works at Acme Corporation.',
        },
      ]);

      expect(result.relationshipsExtracted).toBeGreaterThanOrEqual(1);
    });

    it('should skip already-ingested documents when content is unchanged', async () => {
      await engine.ingestDocuments([{ id: 'doc-1', content: 'John Smith is here.' }]);
      const result = await engine.ingestDocuments([{ id: 'doc-1', content: 'John Smith is here.' }]);

      // Second ingestion should skip the duplicate doc
      expect(result.entitiesExtracted).toBe(0);
    });

    it('should update when re-ingesting the same documentId with different content', async () => {
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'Alice works at Acme Corporation.' },
      ]);

      let entities = await engine.getEntities();
      let names = entities.map(e => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Acme Corporation');

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'Bob studies at Beta University.' },
      ]);

      expect(result.entitiesExtracted).toBeGreaterThan(0);

      entities = await engine.getEntities();
      names = entities.map(e => e.name);
      expect(names).toContain('Bob');
      expect(names).toContain('Beta University');
      expect(names).not.toContain('Alice');
      expect(names).not.toContain('Acme Corporation');
    });

    it('should remove documents and subtract their contributions', async () => {
      await engine.ingestDocuments([{ id: 'doc-1', content: 'Alice works at Acme Corporation.' }]);

      let entities = await engine.getEntities();
      let names = entities.map((e) => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Acme Corporation');

      const removed = await engine.removeDocuments(['doc-1']);
      expect(removed.documentsRemoved).toBe(1);

      entities = await engine.getEntities();
      names = entities.map((e) => e.name);
      expect(names).not.toContain('Alice');
      expect(names).not.toContain('Acme Corporation');

      const stats = await engine.getStats();
      expect(stats.documentsIngested).toBe(0);
    });

    it('should deduplicate entities by name (case-insensitive)', async () => {
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works here.' },
        { id: 'doc-2', content: 'John Smith also lives nearby.' },
      ]);

      const entities = await engine.getEntities();
      const johns = entities.filter(e => e.name.toLowerCase() === 'john smith');
      expect(johns).toHaveLength(1);
      expect(johns[0].frequency).toBeGreaterThan(1);
      expect(johns[0].sourceDocumentIds.length).toBe(2);
    });

    it('should not extract short names (< 3 chars)', async () => {
      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'Al is here. Bo is there. Alexander The Great rules.' },
      ]);

      const entities = await engine.getEntities();
      const names = entities.map(e => e.name);
      // 'Al' and 'Bo' should be excluded (< 3 chars)
      expect(names.every(n => n.length >= 3)).toBe(true);
    });

    it('should handle documents with no extractable entities', async () => {
      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'no proper nouns here at all in this lowercase text.' },
      ]);

      expect(result.entitiesExtracted).toBe(0);
      expect(result.relationshipsExtracted).toBe(0);
    });

    it('should track entity frequency across occurrences', async () => {
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith met John Smith at the John Smith Foundation.' },
      ]);

      const entities = await engine.getEntities();
      const john = entities.find(e => e.name === 'John Smith');
      expect(john).toBeDefined();
      expect(john!.frequency).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // LLM-Based Extraction
  // =========================================================================

  describe('ingestDocuments (LLM extraction)', () => {
    it('should use LLM provider for entity extraction when available', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText.mockResolvedValue(JSON.stringify({
        entities: [
          { name: 'Alice', type: 'person', description: 'A researcher' },
          { name: 'MIT', type: 'organization', description: 'A university' },
        ],
        relationships: [
          { source: 'Alice', target: 'MIT', type: 'works_at', description: 'Alice works at MIT' },
        ],
      }));

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'llm-test' });

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'Alice is a researcher at MIT.' },
      ]);

      expect(llmProvider.generateText).toHaveBeenCalled();
      expect(result.entitiesExtracted).toBe(2);
      expect(result.relationshipsExtracted).toBe(1);

      const entities = await engine.getEntities();
      const names = entities.map(e => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('MIT');
    });

    it('should fallback to pattern extraction on LLM error', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText.mockRejectedValue(new Error('LLM unavailable'));

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'fallback-test' });

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      // Should still extract entities via pattern fallback
      expect(result.entitiesExtracted).toBeGreaterThan(0);
    });

    it('should fallback to pattern extraction on invalid JSON from LLM', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText.mockResolvedValue('This is not valid JSON at all');

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'bad-json-test' });

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      expect(result.entitiesExtracted).toBeGreaterThan(0);
    });

    it('should not create self-referencing relationships', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText.mockResolvedValue(JSON.stringify({
        entities: [{ name: 'Alice', type: 'person', description: 'test' }],
        relationships: [
          { source: 'Alice', target: 'Alice', type: 'self_ref', description: 'Self' },
        ],
      }));

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'self-ref-test' });

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'Alice is Alice.' },
      ]);

      expect(result.relationshipsExtracted).toBe(0);
    });
  });

  // =========================================================================
  // Query Methods
  // =========================================================================

  describe('getEntities', () => {
    beforeEach(async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'query-test' });
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation in New York.' },
      ]);
    });

    it('should return all entities', async () => {
      const entities = await engine.getEntities();
      expect(entities.length).toBeGreaterThan(0);
    });

    it('should filter entities by type', async () => {
      const entities = await engine.getEntities({ type: 'concept' });
      expect(entities.every(e => e.type === 'concept')).toBe(true);
    });

    it('should respect limit option', async () => {
      const entities = await engine.getEntities({ limit: 1 });
      expect(entities.length).toBeLessThanOrEqual(1);
    });
  });

  describe('getRelationships', () => {
    beforeEach(async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'rel-test' });
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);
    });

    it('should return relationships for an entity', async () => {
      const entities = await engine.getEntities();
      if (entities.length > 0) {
        const rels = await engine.getRelationships(entities[0].id);
        // May or may not have relationships depending on extraction
        expect(Array.isArray(rels)).toBe(true);
      }
    });

    it('should return empty for unknown entity', async () => {
      const rels = await engine.getRelationships('nonexistent-id');
      expect(rels).toHaveLength(0);
    });
  });

  describe('getCommunities', () => {
    it('should return empty when no communities detected', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'comm-test' });

      const communities = await engine.getCommunities();
      expect(communities).toHaveLength(0);
    });

    it('should return communities sorted by importance', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'comm-sort-test' });

      // Ingest enough data to potentially create communities
      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith and Jane Doe work at Acme Corporation in New York.' },
        { id: 'doc-2', content: 'Bob Jones and Alice Brown study at State University in California.' },
      ]);

      const communities = await engine.getCommunities();
      for (let i = 1; i < communities.length; i++) {
        expect(communities[i - 1].importance).toBeGreaterThanOrEqual(communities[i].importance);
      }
    });

    it('should filter by level', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'level-filter' });

      const level0 = await engine.getCommunities(0);
      expect(level0.every(c => c.level === 0)).toBe(true);
    });
  });

  // =========================================================================
  // Global Search
  // =========================================================================

  describe('globalSearch', () => {
    it('should return results with text-based fallback (no vector store)', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'global-search-test' });

      const result = await engine.globalSearch('test query');
      expect(result.query).toBe('test query');
      expect(result.totalCommunitiesSearched).toBeDefined();
      expect(Array.isArray(result.communitySummaries)).toBe(true);
      expect(typeof result.answer).toBe('string');
    });

    it('should use vector store for community search when available', async () => {
      const vectorStore = createMockVectorStore();
      const embeddingManager = createMockEmbeddingManager();

      (vectorStore.query as any).mockResolvedValue({
        documents: [],
        queryId: 'q-global',
      });

      engine = new GraphRAGEngine({ vectorStore, embeddingManager });
      await engine.initialize({ engineId: 'global-vec-test' });

      const result = await engine.globalSearch('test query');
      expect(embeddingManager.generateEmbeddings).toHaveBeenCalled();
      expect(vectorStore.query).toHaveBeenCalled();
      expect(result.diagnostics?.searchTimeMs).toBeDefined();
    });

    it('should synthesize answer with LLM when available', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText
        // First call for any ingestion LLM extraction
        .mockResolvedValueOnce('{"entities":[],"relationships":[]}')
        // Second call for synthesis
        .mockResolvedValueOnce('This is the synthesized answer.');

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'synth-test' });

      const result = await engine.globalSearch('what are the themes?');
      expect(result.query).toBe('what are the themes?');
    });

    it('should return diagnostics with timing info', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'diag-test' });

      const result = await engine.globalSearch('test');
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.searchTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Local Search
  // =========================================================================

  describe('localSearch', () => {
    it('should return results with text-based fallback (no vector store)', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'local-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith is a software engineer.' },
      ]);

      const result = await engine.localSearch('John Smith');
      expect(result.query).toBe('John Smith');
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
      expect(typeof result.augmentedContext).toBe('string');
    });

    it('should use vector store for entity search when available', async () => {
      const vectorStore = createMockVectorStore();
      const embeddingManager = createMockEmbeddingManager();

      (vectorStore.query as any).mockResolvedValue({
        documents: [],
        queryId: 'q-local',
      });

      engine = new GraphRAGEngine({ vectorStore, embeddingManager });
      await engine.initialize({ engineId: 'local-vec-test' });

      const result = await engine.localSearch('test entity');
      expect(embeddingManager.generateEmbeddings).toHaveBeenCalled();
      expect(vectorStore.query).toHaveBeenCalled();
      expect(result.diagnostics?.searchTimeMs).toBeDefined();
    });

    it('should include graph traversal diagnostics', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'local-diag' });

      const result = await engine.localSearch('test');
      expect(result.diagnostics?.graphTraversalTimeMs).toBeDefined();
    });

    it('should build augmented context with entities, relationships, and communities', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'context-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      const result = await engine.localSearch('john');
      expect(result.augmentedContext).toContain('## Entities');
      expect(result.augmentedContext).toContain('## Relationships');
      expect(result.augmentedContext).toContain('## Community Context');
    });
  });

  // =========================================================================
  // Stats
  // =========================================================================

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'stats-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      const stats = await engine.getStats();
      expect(stats.documentsIngested).toBe(1);
      expect(stats.totalEntities).toBeGreaterThan(0);
    });

    it('should count community levels', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'levels-test' });

      const stats = await engine.getStats();
      expect(stats.communityLevels).toBe(0);
    });
  });

  // =========================================================================
  // Clear
  // =========================================================================

  describe('clear', () => {
    it('should clear all data', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'clear-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      await engine.clear();
      const stats = await engine.getStats();
      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelationships).toBe(0);
      expect(stats.totalCommunities).toBe(0);
      expect(stats.documentsIngested).toBe(0);
    });

    it('should clear persistence tables when adapter available', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'clear-persist' });

      await engine.clear();
      // Should have called exec with DELETE statements
      const execCalls = (persistence.exec as any).mock.calls;
      const deleteCall = execCalls.find((c: any[]) => c[0].includes('DELETE'));
      expect(deleteCall).toBeDefined();
    });
  });

  // =========================================================================
  // Shutdown
  // =========================================================================

  describe('shutdown', () => {
    it('should persist data on shutdown', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'shutdown-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      await engine.shutdown();

      // Should have persisted entities
      expect(persistence.run).toHaveBeenCalled();
      const insertCalls = (persistence.run as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT'),
      );
      expect(insertCalls.length).toBeGreaterThan(0);
    });

    it('should mark as not initialized after shutdown', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'shutdown-flag' });
      await engine.shutdown();

      await expect(engine.getStats()).rejects.toThrow(/not initialized/i);
    });
  });

  // =========================================================================
  // Persistence
  // =========================================================================

  describe('persistence', () => {
    it('should create schema on initialization', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'schema-test' });

      const execCalls = (persistence.exec as any).mock.calls;
      expect(execCalls.length).toBeGreaterThan(0);

      const schemaCall = execCalls[0][0] as string;
      expect(schemaCall).toContain('CREATE TABLE IF NOT EXISTS');
      expect(schemaCall).toContain('graphrag_entities');
      expect(schemaCall).toContain('graphrag_relationships');
      expect(schemaCall).toContain('graphrag_communities');
      expect(schemaCall).toContain('graphrag_ingested_documents');
    });

    // On Postgres an ALTER TABLE takes an ACCESS EXCLUSIVE lock even when the
    // column exists; the lock waits behind every open reader of the table and
    // later queries queue behind it. A table that already has content_hash
    // must see no ALTER.
    it('should not alter a table that already has content_hash', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'schema-test' });

      const statements = (persistence.exec as any).mock.calls.map((call: unknown[]) => String(call[0]));
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((sql: string) => /ALTER\s+TABLE/i.test(sql))).toEqual([]);
    });

    it('should add content_hash to a table created before the column existed', async () => {
      const persistence = createMockPersistenceAdapter();
      persistence.get.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT content_hash')) throw new Error('no such column: content_hash');
        return null;
      });

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'schema-test' });

      const statements = (persistence.exec as any).mock.calls.map((call: unknown[]) => String(call[0]));
      expect(
        statements.some((sql: string) =>
          /ALTER TABLE \S*ingested_documents ADD COLUMN content_hash TEXT/.test(sql),
        ),
      ).toBe(true);
    });

    it('should load data from persistence on initialization', async () => {
      const persistence = createMockPersistenceAdapter();
      (persistence.all as any)
        .mockResolvedValueOnce([ // entities
          {
            id: 'e1',
            name: 'Test Entity',
            type: 'concept',
            description: 'A test',
            properties_json: '{}',
            embedding_json: null,
            source_document_ids_json: '["doc-1"]',
            frequency: 1,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ])
        .mockResolvedValueOnce([]) // relationships
        .mockResolvedValueOnce([]) // communities
        .mockResolvedValueOnce([]); // ingested docs

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'load-test' });

      const entities = await engine.getEntities();
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('Test Entity');
    });

    it('should use custom table prefix', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'prefix-test', tablePrefix: 'custom_' });

      const execCalls = (persistence.exec as any).mock.calls;
      const schemaCall = execCalls[0][0] as string;
      expect(schemaCall).toContain('custom_entities');
      expect(schemaCall).toContain('custom_relationships');
    });

    it('should persist entities with correct SQL parameters', async () => {
      const persistence = createMockPersistenceAdapter();

      engine = new GraphRAGEngine({ persistenceAdapter: persistence });
      await engine.initialize({ engineId: 'persist-params' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith is here.' },
      ]);

      await engine.shutdown();

      const insertCalls = (persistence.run as any).mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT') && c[0].includes('entities'),
      );
      expect(insertCalls.length).toBeGreaterThan(0);

      // Check the parameters include entity fields
      const params = insertCalls[0][1];
      expect(params).toBeDefined();
      expect(typeof params[0]).toBe('string'); // id
      expect(typeof params[1]).toBe('string'); // name
      expect(typeof params[2]).toBe('string'); // type
    });
  });

  // =========================================================================
  // Entity Embeddings
  // =========================================================================

  describe('entity embeddings', () => {
    it('should generate embeddings when vectorStore and embeddingManager available', async () => {
      const vectorStore = createMockVectorStore();
      const embeddingManager = createMockEmbeddingManager();

      engine = new GraphRAGEngine({ vectorStore, embeddingManager });
      await engine.initialize({
        engineId: 'embed-test',
        generateEntityEmbeddings: true,
      });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      expect(embeddingManager.generateEmbeddings).toHaveBeenCalled();
      expect(vectorStore.upsert).toHaveBeenCalled();
    });

    it('should skip embedding generation when disabled', async () => {
      const vectorStore = createMockVectorStore();
      const embeddingManager = createMockEmbeddingManager();

      engine = new GraphRAGEngine({ vectorStore, embeddingManager });
      await engine.initialize({
        engineId: 'no-embed',
        generateEntityEmbeddings: false,
      });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      // generateEmbeddings should not be called for entity embedding
      // (it might be called for collection setup, but not for entity batch)
      const embedCalls = (embeddingManager.generateEmbeddings as any).mock.calls;
      const entityEmbedCalls = embedCalls.filter(
        (c: any[]) => c[0]?.texts && Array.isArray(c[0].texts) && c[0].texts.length > 0,
      );
      expect(entityEmbedCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // Community Summarization
  // =========================================================================

  describe('community summarization', () => {
    it('should generate summaries with LLM when available', async () => {
      const llmProvider = createMockLLMProvider();

      // First call: extraction, subsequent calls: summarization
      llmProvider.generateText
        .mockResolvedValueOnce(JSON.stringify({
          entities: [
            { name: 'Alice', type: 'person', description: 'A scientist' },
            { name: 'Bob', type: 'person', description: 'A researcher' },
            { name: 'MIT', type: 'organization', description: 'University' },
          ],
          relationships: [
            { source: 'Alice', target: 'MIT', type: 'works_at', description: 'Alice at MIT' },
            { source: 'Bob', target: 'MIT', type: 'studies_at', description: 'Bob at MIT' },
          ],
        }))
        .mockResolvedValue('This community contains scientists and researchers at MIT.');

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'summary-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'Alice is a scientist at MIT. Bob is a researcher at MIT.' },
      ]);

      // LLM should have been called for summarization (beyond just extraction)
      expect(llmProvider.generateText).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle empty document list', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'empty-docs' });

      const result = await engine.ingestDocuments([]);
      expect(result.documentsProcessed).toBe(0);
      expect(result.entitiesExtracted).toBe(0);
    });

    it('should handle document with empty content', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'empty-content' });

      const result = await engine.ingestDocuments([{ id: 'doc-1', content: '' }]);
      expect(result.documentsProcessed).toBe(1);
      expect(result.entitiesExtracted).toBe(0);
    });

    it('should handle very long document content (truncation)', async () => {
      const llmProvider = createMockLLMProvider();
      llmProvider.generateText.mockResolvedValue('{"entities":[],"relationships":[]}');

      engine = new GraphRAGEngine({ llmProvider });
      await engine.initialize({ engineId: 'long-doc' });

      const longContent = 'A'.repeat(20000);
      const result = await engine.ingestDocuments([{ id: 'doc-1', content: longContent }]);

      expect(result.documentsProcessed).toBe(1);
      // LLM should have been called with truncated content
      const callArgs = llmProvider.generateText.mock.calls[0][0] as string;
      expect(callArgs.length).toBeLessThan(20000);
    });

    it('should handle globalSearch on empty engine', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'empty-global' });

      const result = await engine.globalSearch('anything');
      expect(result.communitySummaries).toHaveLength(0);
    });

    it('should handle localSearch on empty engine', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'empty-local' });

      const result = await engine.localSearch('anything');
      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('should handle metadata on ingested documents', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'metadata-test' });

      const result = await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith is here.', metadata: { source: 'test', version: 1 } },
      ]);

      expect(result.documentsProcessed).toBe(1);
    });

    it('should handle concurrent clear and query gracefully', async () => {
      engine = new GraphRAGEngine();
      await engine.initialize({ engineId: 'concurrent-test' });

      await engine.ingestDocuments([
        { id: 'doc-1', content: 'John Smith works at Acme Corporation.' },
      ]);

      await engine.clear();
      const stats = await engine.getStats();
      expect(stats.totalEntities).toBe(0);
    });
  });
});
