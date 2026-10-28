/**
 * @file KnowledgeGraph.ts
 * @description In-memory implementation of the Knowledge Graph.
 * Provides entity-relationship storage, episodic memory, and semantic search.
 *
 * @module AgentOS/Knowledge
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  IKnowledgeGraph,
  KnowledgeEntity,
  KnowledgeRelation,
  EpisodicMemory,
  EntityId,
  RelationId,
  EntityType,
  RelationType,
  KnowledgeQueryOptions,
  TraversalOptions,
  TraversalResult,
  SemanticSearchOptions,
  SemanticSearchResult,
  KnowledgeGraphStats,
  KnowledgeSource,
  MemoryCopyFilter,
} from './IKnowledgeGraph';
import { copiedTraceId, copyKey, filterTraceIds, isEmptyCopyFilter, isMemoryCopyOf } from './memoryCopies.js';
import type { ILogger } from '../../../../../core/logging/ILogger';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager';

/**
 * Configuration for KnowledgeGraph
 */
export interface KnowledgeGraphConfig {
  /** Embedding manager for semantic search */
  embeddingManager?: IEmbeddingManager;
  /** Logger instance */
  logger?: ILogger;
  /** Memory decay rate per day (0-1) */
  memoryDecayRate?: number;
  /** Minimum importance to retain memories */
  minImportanceThreshold?: number;
}

/**
 * In-memory Knowledge Graph implementation
 */
export class KnowledgeGraph implements IKnowledgeGraph {
  private readonly entities = new Map<EntityId, KnowledgeEntity>();
  private readonly relations = new Map<RelationId, KnowledgeRelation>();
  private readonly memories = new Map<string, EpisodicMemory>();
  
  // Indexes for efficient querying
  private readonly entityByType = new Map<EntityType, Set<EntityId>>();
  private readonly relationsBySource = new Map<EntityId, Set<RelationId>>();
  private readonly relationsByTarget = new Map<EntityId, Set<RelationId>>();
  private readonly entitiesByOwner = new Map<string, Set<EntityId>>();

  private readonly embeddingManager?: IEmbeddingManager;
  private readonly logger?: ILogger;
  private readonly memoryDecayRate: number;
  private readonly minImportanceThreshold: number;

  constructor(config: KnowledgeGraphConfig = {}) {
    this.embeddingManager = config.embeddingManager;
    this.logger = config.logger;
    this.memoryDecayRate = config.memoryDecayRate ?? 0.01;
    this.minImportanceThreshold = config.minImportanceThreshold ?? 0.1;
  }

  async initialize(): Promise<void> {
    this.logger?.info?.('KnowledgeGraph initialized');
  }

  // ============================================================================
  // Entity Operations
  // ============================================================================

  async upsertEntity(
    entityInput: Omit<KnowledgeEntity, 'id' | 'createdAt' | 'updatedAt'> & { id?: EntityId }
  ): Promise<KnowledgeEntity> {
    const now = new Date().toISOString();
    const existing = entityInput.id ? this.entities.get(entityInput.id) : undefined;

    const entity: KnowledgeEntity = {
      ...entityInput,
      id: entityInput.id || `entity-${uuidv4()}`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // Generate embedding if not provided and embedding manager available
    if (!entity.embedding && this.embeddingManager) {
      try {
        const embedResult = await this.embeddingManager.generateEmbeddings({
          texts: `${entity.label} ${JSON.stringify(entity.properties)}`,
        });
        entity.embedding = embedResult.embeddings[0];
      } catch (error) {
        this.logger?.warn?.('Failed to generate entity embedding', { entityId: entity.id, error });
      }
    }

    this.entities.set(entity.id, entity);

    // Update indexes
    if (!this.entityByType.has(entity.type)) {
      this.entityByType.set(entity.type, new Set());
    }
    this.entityByType.get(entity.type)!.add(entity.id);

    if (entity.ownerId) {
      if (!this.entitiesByOwner.has(entity.ownerId)) {
        this.entitiesByOwner.set(entity.ownerId, new Set());
      }
      this.entitiesByOwner.get(entity.ownerId)!.add(entity.id);
    }

    this.logger?.debug?.('Entity upserted', { entityId: entity.id, type: entity.type });
    return entity;
  }

  async getEntity(id: EntityId): Promise<KnowledgeEntity | undefined> {
    return this.entities.get(id);
  }

  async queryEntities(options?: KnowledgeQueryOptions): Promise<KnowledgeEntity[]> {
    let results = Array.from(this.entities.values());

    // Filter by type
    if (options?.entityTypes?.length) {
      const typeSet = new Set(options.entityTypes);
      results = results.filter(e => typeSet.has(e.type));
    }

    // Filter by owner
    if (options?.ownerId) {
      results = results.filter(e => e.ownerId === options.ownerId);
    }

    // Filter by tags
    if (options?.tags?.length) {
      const tagSet = new Set(options.tags);
      results = results.filter(e => e.tags?.some(t => tagSet.has(t)));
    }

    // Filter by confidence
    if (options?.minConfidence !== undefined) {
      results = results.filter(e => e.confidence >= options.minConfidence!);
    }

    // Filter by time range
    if (options?.timeRange) {
      if (options.timeRange.from) {
        results = results.filter(e => e.createdAt >= options.timeRange!.from!);
      }
      if (options.timeRange.to) {
        results = results.filter(e => e.createdAt <= options.timeRange!.to!);
      }
    }

    // Remove embeddings if not requested
    if (!options?.includeEmbeddings) {
      results = results.map(e => ({ ...e, embedding: undefined }));
    }

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    return results.slice(offset, offset + limit);
  }

  async deleteEntity(id: EntityId): Promise<boolean> {
    const entity = this.entities.get(id);
    if (!entity) return false;

    // Remove from indexes
    this.entityByType.get(entity.type)?.delete(id);
    if (entity.ownerId) {
      this.entitiesByOwner.get(entity.ownerId)?.delete(id);
    }

    // Remove relations
    const relationsToDelete = [
      ...(this.relationsBySource.get(id) || []),
      ...(this.relationsByTarget.get(id) || []),
    ];
    for (const relId of relationsToDelete) {
      await this.deleteRelation(relId);
    }

    this.entities.delete(id);
    this.logger?.debug?.('Entity deleted', { entityId: id });
    return true;
  }

  // ============================================================================
  // Relation Operations
  // ============================================================================

  async upsertRelation(
    relationInput: Omit<KnowledgeRelation, 'id' | 'createdAt'> & { id?: RelationId }
  ): Promise<KnowledgeRelation> {
    const now = new Date().toISOString();

    const relation: KnowledgeRelation = {
      ...relationInput,
      id: relationInput.id || `rel-${uuidv4()}`,
      createdAt: now,
    };

    this.relations.set(relation.id, relation);

    // Update indexes
    if (!this.relationsBySource.has(relation.sourceId)) {
      this.relationsBySource.set(relation.sourceId, new Set());
    }
    this.relationsBySource.get(relation.sourceId)!.add(relation.id);

    if (!this.relationsByTarget.has(relation.targetId)) {
      this.relationsByTarget.set(relation.targetId, new Set());
    }
    this.relationsByTarget.get(relation.targetId)!.add(relation.id);

    this.logger?.debug?.('Relation upserted', {
      relationId: relation.id,
      source: relation.sourceId,
      target: relation.targetId,
      type: relation.type,
    });
    return relation;
  }

  async getRelations(
    entityId: EntityId,
    options?: { direction?: 'outgoing' | 'incoming' | 'both'; types?: RelationType[] }
  ): Promise<KnowledgeRelation[]> {
    const direction = options?.direction || 'both';
    const types = options?.types ? new Set(options.types) : null;
    const results: KnowledgeRelation[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = this.relationsBySource.get(entityId) || new Set();
      for (const relId of outgoing) {
        const rel = this.relations.get(relId);
        if (rel && (!types || types.has(rel.type))) {
          results.push(rel);
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const incoming = this.relationsByTarget.get(entityId) || new Set();
      for (const relId of incoming) {
        const rel = this.relations.get(relId);
        if (rel && (!types || types.has(rel.type))) {
          results.push(rel);
        }
      }
    }

    return results;
  }

  async deleteRelation(id: RelationId): Promise<boolean> {
    const relation = this.relations.get(id);
    if (!relation) return false;

    this.relationsBySource.get(relation.sourceId)?.delete(id);
    this.relationsByTarget.get(relation.targetId)?.delete(id);
    this.relations.delete(id);

    this.logger?.debug?.('Relation deleted', { relationId: id });
    return true;
  }

  // ============================================================================
  // Episodic Memory Operations
  // ============================================================================

  async recordMemory(
    memoryInput: Omit<EpisodicMemory, 'id' | 'createdAt' | 'accessCount' | 'lastAccessedAt'>
  ): Promise<EpisodicMemory> {
    const now = new Date().toISOString();
    const traceId = copiedTraceId(memoryInput.context);

    const memory: EpisodicMemory = {
      ...memoryInput,
      // A memory trace's copy is keyed by its trace: recording the trace again replaces the copy, and a delete by
      // trace id finds it by key.
      id: traceId === undefined ? `mem-${uuidv4()}` : copyKey(traceId),
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    };

    // Generate embedding if not provided
    if (!memory.embedding && this.embeddingManager) {
      try {
        const embedResult = await this.embeddingManager.generateEmbeddings({
          texts: `${memory.summary} ${memory.description || ''}`,
        });
        memory.embedding = embedResult.embeddings[0];
      } catch (error) {
        this.logger?.warn?.('Failed to generate memory embedding', { memoryId: memory.id, error });
      }
    }

    this.memories.set(memory.id, memory);
    this.logger?.debug?.('Memory recorded', { memoryId: memory.id, type: memory.type });
    return memory;
  }

  async getMemory(id: string): Promise<EpisodicMemory | undefined> {
    const memory = this.memories.get(id);
    if (memory) {
      // Update access stats
      memory.accessCount++;
      memory.lastAccessedAt = new Date().toISOString();
    }
    return memory;
  }

  async queryMemories(options?: {
    types?: EpisodicMemory['type'][];
    participants?: string[];
    minImportance?: number;
    timeRange?: { from?: string; to?: string };
    limit?: number;
  }): Promise<EpisodicMemory[]> {
    let results = Array.from(this.memories.values());

    if (options?.types?.length) {
      const typeSet = new Set(options.types);
      results = results.filter(m => typeSet.has(m.type));
    }

    if (options?.participants?.length) {
      const participantSet = new Set(options.participants);
      results = results.filter(m => m.participants.some(p => participantSet.has(p)));
    }

    if (options?.minImportance !== undefined) {
      results = results.filter(m => m.importance >= options.minImportance!);
    }

    if (options?.timeRange) {
      if (options.timeRange.from) {
        results = results.filter(m => m.occurredAt >= options.timeRange!.from!);
      }
      if (options.timeRange.to) {
        results = results.filter(m => m.occurredAt <= options.timeRange!.to!);
      }
    }

    // Sort by importance and recency
    results.sort((a, b) => {
      const importanceDiff = b.importance - a.importance;
      if (importanceDiff !== 0) return importanceDiff;
      return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
    });

    return results.slice(0, options?.limit || 50);
  }

  async recallMemories(query: string, topK = 5): Promise<EpisodicMemory[]> {
    if (!this.embeddingManager) {
      // Fallback to text matching
      const queryLower = query.toLowerCase();
      return Array.from(this.memories.values())
        .filter(m => m.summary.toLowerCase().includes(queryLower))
        .slice(0, topK);
    }

    const queryEmbedResult = await this.embeddingManager.generateEmbeddings({ texts: query });
    const queryEmbedding = queryEmbedResult.embeddings[0];
    const memoriesWithScores: Array<{ memory: EpisodicMemory; score: number }> = [];

    for (const memory of this.memories.values()) {
      if (memory.embedding) {
        const score = this.cosineSimilarity(queryEmbedding, memory.embedding);
        memoriesWithScores.push({ memory, score });
      }
    }

    memoriesWithScores.sort((a, b) => b.score - a.score);

    const results = memoriesWithScores.slice(0, topK).map(({ memory }) => {
      memory.accessCount++;
      memory.lastAccessedAt = new Date().toISOString();
      return memory;
    });

    return results;
  }

  /**
   * Delete the episodic records that copy the filter's traces or scopes: a trace's copy by its key, a scope's copies
   * by the scope their stored context names.
   */
  async deleteMemories(filter: MemoryCopyFilter): Promise<number> {
    if (isEmptyCopyFilter(filter)) return 0;
    let deleted = 0;
    for (const traceId of filterTraceIds(filter)) {
      if (this.memories.delete(copyKey(traceId))) deleted += 1;
    }
    if (filter.scopes?.length) {
      const byScope: MemoryCopyFilter = { scopes: filter.scopes };
      for (const [id, memory] of this.memories) {
        if (isMemoryCopyOf(memory.context, byScope)) {
          this.memories.delete(id);
          deleted += 1;
        }
      }
    }
    return deleted;
  }

  // ============================================================================
  // Graph Traversal
  // ============================================================================

  async traverse(startEntityId: EntityId, options?: TraversalOptions): Promise<TraversalResult> {
    const maxDepth = options?.maxDepth || 3;
    const direction = options?.direction || 'both';
    const maxNodes = options?.maxNodes || 100;
    const relationTypes = options?.relationTypes ? new Set(options.relationTypes) : null;
    const minWeight = options?.minWeight || 0;

    const root = this.entities.get(startEntityId);
    if (!root) {
      throw new Error(`Entity not found: ${startEntityId}`);
    }

    const visited = new Set<EntityId>([startEntityId]);
    const levels: TraversalResult['levels'] = [];
    let currentLevel = [startEntityId];
    let totalRelations = 0;

    for (let depth = 1; depth <= maxDepth && currentLevel.length > 0; depth++) {
      const nextLevel: EntityId[] = [];
      const levelEntities: KnowledgeEntity[] = [];
      const levelRelations: KnowledgeRelation[] = [];

      for (const entityId of currentLevel) {
        if (visited.size >= maxNodes) break;

        const relations = await this.getRelations(entityId, { direction });

        for (const rel of relations) {
          if (relationTypes && !relationTypes.has(rel.type)) continue;
          if (rel.weight < minWeight) continue;

          const targetId = rel.sourceId === entityId ? rel.targetId : rel.sourceId;

          if (!visited.has(targetId)) {
            visited.add(targetId);
            nextLevel.push(targetId);

            const targetEntity = this.entities.get(targetId);
            if (targetEntity) {
              levelEntities.push(targetEntity);
            }
          }

          levelRelations.push(rel);
          totalRelations++;
        }
      }

      if (levelEntities.length > 0) {
        levels.push({ depth, entities: levelEntities, relations: levelRelations });
      }

      currentLevel = nextLevel;
    }

    return {
      root,
      levels,
      totalEntities: visited.size,
      totalRelations,
    };
  }

  async findPath(
    sourceId: EntityId,
    targetId: EntityId,
    maxDepth = 5
  ): Promise<Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> | null> {
    const source = this.entities.get(sourceId);
    const target = this.entities.get(targetId);

    if (!source || !target) return null;
    if (sourceId === targetId) return [{ entity: source }];

    // BFS to find shortest path
    const visited = new Set<EntityId>([sourceId]);
    const queue: Array<{ entityId: EntityId; path: Array<{ entityId: EntityId; relationId?: RelationId }> }> = [
      { entityId: sourceId, path: [{ entityId: sourceId }] },
    ];

    while (queue.length > 0) {
      const { entityId, path } = queue.shift()!;

      if (path.length > maxDepth) continue;

      const relations = await this.getRelations(entityId, { direction: 'both' });

      for (const rel of relations) {
        const nextId = rel.sourceId === entityId ? rel.targetId : rel.sourceId;

        if (nextId === targetId) {
          // Found path!
          const fullPath = [...path, { entityId: nextId, relationId: rel.id }];
          return fullPath.map(({ entityId: eid, relationId }) => ({
            entity: this.entities.get(eid)!,
            relation: relationId ? this.relations.get(relationId) : undefined,
          }));
        }

        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({
            entityId: nextId,
            path: [...path, { entityId: nextId, relationId: rel.id }],
          });
        }
      }
    }

    return null;
  }

  async getNeighborhood(
    entityId: EntityId,
    depth = 1
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    const result = await this.traverse(entityId, { maxDepth: depth });

    const entities = [result.root, ...result.levels.flatMap(l => l.entities)];
    const relations = result.levels.flatMap(l => l.relations);

    return { entities, relations };
  }

  // ============================================================================
  // Semantic Search
  // ============================================================================

  async semanticSearch(options: SemanticSearchOptions): Promise<SemanticSearchResult[]> {
    const topK = options.topK || 10;
    const minSimilarity = options.minSimilarity || 0.5;
    const scope = options.scope || 'all';

    if (!this.embeddingManager) {
      // Fallback to text matching
      return this.textBasedSearch(options);
    }

    const queryEmbedResult = await this.embeddingManager.generateEmbeddings({ texts: options.query });
    const queryEmbedding = queryEmbedResult.embeddings[0];
    const results: SemanticSearchResult[] = [];

    // Search entities
    if (scope === 'entities' || scope === 'all') {
      for (const entity of this.entities.values()) {
        if (options.ownerId && entity.ownerId !== options.ownerId) continue;
        if (options.entityTypes?.length && !options.entityTypes.includes(entity.type)) continue;
        if (!entity.embedding) continue;

        const similarity = this.cosineSimilarity(queryEmbedding, entity.embedding);
        if (similarity >= minSimilarity) {
          results.push({ item: entity, type: 'entity', similarity });
        }
      }
    }

    // Search memories
    if (scope === 'memories' || scope === 'all') {
      for (const memory of this.memories.values()) {
        if (!memory.embedding) continue;

        const similarity = this.cosineSimilarity(queryEmbedding, memory.embedding);
        if (similarity >= minSimilarity) {
          results.push({ item: memory, type: 'memory', similarity });
        }
      }
    }

    // Sort by similarity and return top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  private textBasedSearch(options: SemanticSearchOptions): SemanticSearchResult[] {
    const queryLower = options.query.toLowerCase();
    const results: SemanticSearchResult[] = [];

    if (options.scope === 'entities' || options.scope === 'all') {
      for (const entity of this.entities.values()) {
        if (entity.label.toLowerCase().includes(queryLower)) {
          results.push({ item: entity, type: 'entity', similarity: 0.7 });
        }
      }
    }

    if (options.scope === 'memories' || options.scope === 'all') {
      for (const memory of this.memories.values()) {
        if (memory.summary.toLowerCase().includes(queryLower)) {
          results.push({ item: memory, type: 'memory', similarity: 0.7 });
        }
      }
    }

    return results.slice(0, options.topK || 10);
  }

  // ============================================================================
  // Knowledge Extraction
  // ============================================================================

  async extractFromText(
    text: string,
    options?: { extractRelations?: boolean; entityTypes?: EntityType[] }
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    // Simple extraction using patterns (in production, use NLP/LLM)
    const entities: KnowledgeEntity[] = [];
    const relations: KnowledgeRelation[] = [];

    const source: KnowledgeSource = {
      type: 'inference',
      timestamp: new Date().toISOString(),
      method: 'pattern_extraction',
    };

    // Extract potential entities (capitalized words/phrases)
    const entityPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
    const matches = text.match(entityPattern) || [];
    const uniqueLabels = [...new Set(matches)];

    for (const label of uniqueLabels) {
      const entity = await this.upsertEntity({
        type: 'concept',
        label,
        properties: {},
        confidence: 0.5,
        source,
      });
      entities.push(entity);
    }

    // Extract simple relations if requested
    if (options?.extractRelations && entities.length > 1) {
      for (let i = 0; i < entities.length - 1; i++) {
        const relation = await this.upsertRelation({
          sourceId: entities[i].id,
          targetId: entities[i + 1].id,
          type: 'related_to',
          label: 'related_to',
          weight: 0.3,
          bidirectional: true,
          confidence: 0.3,
          source,
        });
        relations.push(relation);
      }
    }

    return { entities, relations };
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  async mergeEntities(entityIds: EntityId[], primaryId: EntityId): Promise<KnowledgeEntity> {
    const primary = this.entities.get(primaryId);
    if (!primary) throw new Error(`Primary entity not found: ${primaryId}`);

    for (const id of entityIds) {
      if (id === primaryId) continue;

      const entity = this.entities.get(id);
      if (!entity) continue;

      // Merge properties
      primary.properties = { ...entity.properties, ...primary.properties };
      primary.tags = [...new Set([...(primary.tags || []), ...(entity.tags || [])])];

      // Redirect relations
      const relations = await this.getRelations(id, { direction: 'both' });
      for (const rel of relations) {
        if (rel.sourceId === id) {
          rel.sourceId = primaryId;
        }
        if (rel.targetId === id) {
          rel.targetId = primaryId;
        }
      }

      // Delete merged entity
      await this.deleteEntity(id);
    }

    primary.updatedAt = new Date().toISOString();
    this.logger?.info?.('Entities merged', { mergedIds: entityIds, primaryId });
    return primary;
  }

  async decayMemories(decayFactor?: number): Promise<number> {
    const factor = decayFactor ?? this.memoryDecayRate;
    let decayedCount = 0;

    const now = Date.now();

    for (const memory of this.memories.values()) {
      const ageMs = now - new Date(memory.lastAccessedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      // Apply decay based on age and access frequency
      const accessBoost = Math.log10(memory.accessCount + 1) * 0.1;
      const newImportance = memory.importance * Math.pow(1 - factor, ageDays) + accessBoost;
      memory.importance = Math.max(0, Math.min(1, newImportance));

      // Remove memories below threshold
      if (memory.importance < this.minImportanceThreshold) {
        this.memories.delete(memory.id);
        decayedCount++;
      }
    }

    this.logger?.info?.('Memory decay applied', { decayedCount, factor });
    return decayedCount;
  }

  async getStats(): Promise<KnowledgeGraphStats> {
    const entitiesByType: Record<EntityType, number> = {} as any;
    const relationsByType: Record<RelationType, number> = {} as any;

    for (const entity of this.entities.values()) {
      entitiesByType[entity.type] = (entitiesByType[entity.type] || 0) + 1;
    }

    for (const relation of this.relations.values()) {
      relationsByType[relation.type] = (relationsByType[relation.type] || 0) + 1;
    }

    const entities = Array.from(this.entities.values());
    const avgConfidence = entities.length > 0
      ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
      : 0;

    const allDates = [
      ...entities.map(e => e.createdAt),
      ...Array.from(this.memories.values()).map(m => m.createdAt),
    ].sort();

    return {
      totalEntities: this.entities.size,
      totalRelations: this.relations.size,
      totalMemories: this.memories.size,
      entitiesByType,
      relationsByType,
      avgConfidence,
      oldestEntry: allDates[0] || '',
      newestEntry: allDates[allDates.length - 1] || '',
    };
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.relations.clear();
    this.memories.clear();
    this.entityByType.clear();
    this.relationsBySource.clear();
    this.relationsByTarget.clear();
    this.entitiesByOwner.clear();
    this.logger?.info?.('Knowledge graph cleared');
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}

