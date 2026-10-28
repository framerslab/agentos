/**
 * @fileoverview Neo4j-backed Knowledge Graph implementation.
 *
 * Implements `IKnowledgeGraph` using Neo4j for persistent entity/relation/memory
 * storage with native Cypher traversal, shortest path, and vector index-based
 * semantic search.
 *
 * Features:
 * - Persistent entity/relation storage via Neo4j
 * - Native BFS traversal and shortest path via Cypher variable-length paths
 * - Vector indexes on KnowledgeEntity.embedding and EpisodicMemory.embedding
 * - Dynamic relationship types via APOC merge.relationship
 * - Memory decay via Cypher-based exponential formula
 * - Shared Neo4jConnectionManager for connection pooling
 *
 * @module @framers/agentos/knowledge/Neo4jKnowledgeGraph
 * @see ./IKnowledgeGraph.ts for the interface definition.
 */

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
  MemoryCopyFilter,
} from './IKnowledgeGraph.js';
import {
  TRACE_CONTEXT_MARKER,
  copiedTraceId,
  filterTraceIds,
  isEmptyCopyFilter,
  isMemoryCopyOf,
  scopeNeedles,
} from './memoryCopies.js';
import type { Neo4jConnectionManager } from '../neo4j/Neo4jConnectionManager.js';
import { Neo4jCypherRunner } from '../neo4j/Neo4jCypherRunner.js';

// ============================================================================
// Constants
// ============================================================================

const ENTITY_LABEL = 'KnowledgeEntity';
const MEMORY_LABEL = 'EpisodicMemory';
const ENTITY_VEC_INDEX = 'knowledge_entity_embeddings';
const MEMORY_VEC_INDEX = 'episodic_memory_embeddings';
const DEFAULT_EMBEDDING_DIM = 1536;

// Map interface relation types to Neo4j relationship type strings
function relTypeToNeo4j(type: RelationType): string {
  return type.toUpperCase();
}

function neo4jToRelType(type: string): RelationType {
  return type.toLowerCase() as RelationType;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================================
// Configuration
// ============================================================================

export interface Neo4jKnowledgeGraphConfig {
  connectionManager: Neo4jConnectionManager;
  embeddingDimension?: number;
  memoryDecayRate?: number;
  minImportanceThreshold?: number;
}

// ============================================================================
// Implementation
// ============================================================================

export class Neo4jKnowledgeGraph implements IKnowledgeGraph {
  private cypher!: Neo4jCypherRunner;
  /** This graph's pass over the trace copies an older release recorded, once it has started ({@link backfillCopyTraceIds}). */
  private copyTraceIdsBackfilled: Promise<void> | null = null;
  private embeddingDimension: number;
  private memoryDecayRate: number;
  private minImportanceThreshold: number;

  constructor(private config: Neo4jKnowledgeGraphConfig) {
    this.embeddingDimension = config.embeddingDimension ?? DEFAULT_EMBEDDING_DIM;
    this.memoryDecayRate = config.memoryDecayRate ?? 0.01;
    this.minImportanceThreshold = config.minImportanceThreshold ?? 0.05;
  }

  async initialize(): Promise<void> {
    this.cypher = new Neo4jCypherRunner(this.config.connectionManager);

    // Create constraints for fast lookups
    await this.cypher.writeVoid(
      `CREATE CONSTRAINT ke_unique IF NOT EXISTS FOR (n:${ENTITY_LABEL}) REQUIRE n.entityId IS UNIQUE`,
    );
    await this.cypher.writeVoid(
      `CREATE CONSTRAINT em_unique IF NOT EXISTS FOR (n:${MEMORY_LABEL}) REQUIRE n.memoryId IS UNIQUE`,
    );
    // A memory trace's copy carries its trace id, which a delete by trace id reads through.
    await this.cypher.writeVoid(`CREATE INDEX em_trace_id IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.traceId)`);

    // Create vector indexes for semantic search
    await this.cypher.writeVoid(
      `CREATE VECTOR INDEX ${ENTITY_VEC_INDEX} IF NOT EXISTS
       FOR (n:${ENTITY_LABEL}) ON (n.embedding)
       OPTIONS { indexConfig: {
         \`vector.dimensions\`: toInteger($dim),
         \`vector.similarity_function\`: 'cosine'
       }}`,
      { dim: this.embeddingDimension },
    );
    await this.cypher.writeVoid(
      `CREATE VECTOR INDEX ${MEMORY_VEC_INDEX} IF NOT EXISTS
       FOR (n:${MEMORY_LABEL}) ON (n.embedding)
       OPTIONS { indexConfig: {
         \`vector.dimensions\`: toInteger($dim),
         \`vector.similarity_function\`: 'cosine'
       }}`,
      { dim: this.embeddingDimension },
    );
  }

  // ============ Entity Operations ============

  async upsertEntity(
    entity: Omit<KnowledgeEntity, 'id' | 'createdAt' | 'updatedAt'> & { id?: EntityId },
  ): Promise<KnowledgeEntity> {
    const id = entity.id ?? generateId();
    const now = nowIso();

    const results = await this.cypher.write<{ e: any }>(
      `MERGE (e:${ENTITY_LABEL} { entityId: $id })
       ON CREATE SET
         e.type = $type,
         e.label = $label,
         e.properties_json = $properties_json,
         e.embedding = $embedding,
         e.confidence = $confidence,
         e.source_json = $source_json,
         e.ownerId = $ownerId,
         e.tags = $tags,
         e.metadata_json = $metadata_json,
         e.createdAt = $now,
         e.updatedAt = $now
       ON MATCH SET
         e.type = $type,
         e.label = $label,
         e.properties_json = $properties_json,
         e.embedding = CASE WHEN $embedding IS NOT NULL THEN $embedding ELSE e.embedding END,
         e.confidence = $confidence,
         e.source_json = $source_json,
         e.ownerId = $ownerId,
         e.tags = $tags,
         e.metadata_json = $metadata_json,
         e.updatedAt = $now
       RETURN e`,
      {
        id,
        type: entity.type,
        label: entity.label,
        properties_json: JSON.stringify(entity.properties),
        embedding: entity.embedding ?? null,
        confidence: entity.confidence,
        source_json: JSON.stringify(entity.source),
        ownerId: entity.ownerId ?? null,
        tags: entity.tags ?? [],
        metadata_json: entity.metadata ? JSON.stringify(entity.metadata) : null,
        now,
      },
    );

    return this.nodeToEntity(results[0]?.e, id, now);
  }

  async getEntity(id: EntityId): Promise<KnowledgeEntity | undefined> {
    const results = await this.cypher.read<{ e: any }>(
      `MATCH (e:${ENTITY_LABEL} { entityId: $id }) RETURN e`,
      { id },
    );
    if (results.length === 0) return undefined;
    return this.nodeToEntity(results[0].e);
  }

  async queryEntities(options?: KnowledgeQueryOptions): Promise<KnowledgeEntity[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (options?.entityTypes?.length) {
      conditions.push('e.type IN $entityTypes');
      params.entityTypes = options.entityTypes;
    }
    if (options?.ownerId) {
      conditions.push('e.ownerId = $ownerId');
      params.ownerId = options.ownerId;
    }
    if (options?.tags?.length) {
      conditions.push('ANY(tag IN $tags WHERE tag IN e.tags)');
      params.tags = options.tags;
    }
    if (options?.minConfidence !== undefined) {
      conditions.push('e.confidence >= $minConfidence');
      params.minConfidence = options.minConfidence;
    }
    if (options?.timeRange?.from) {
      conditions.push('e.createdAt >= $from');
      params.from = options.timeRange.from;
    }
    if (options?.timeRange?.to) {
      conditions.push('e.createdAt <= $to');
      params.to = options.timeRange.to;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const results = await this.cypher.read<{ e: any }>(
      `MATCH (e:${ENTITY_LABEL}) ${where}
       RETURN e
       ORDER BY e.updatedAt DESC
       SKIP $offset LIMIT $limit`,
      { ...params, offset, limit },
    );

    return results.map((r) => this.nodeToEntity(r.e));
  }

  async deleteEntity(id: EntityId): Promise<boolean> {
    const results = await this.cypher.write<{ deleted: number }>(
      `MATCH (e:${ENTITY_LABEL} { entityId: $id })
       DETACH DELETE e
       RETURN 1 AS deleted`,
      { id },
    );
    return results.length > 0;
  }

  // ============ Relation Operations ============

  async upsertRelation(
    relation: Omit<KnowledgeRelation, 'id' | 'createdAt'> & { id?: RelationId },
  ): Promise<KnowledgeRelation> {
    const id = relation.id ?? generateId();
    const now = nowIso();
    const relType = relTypeToNeo4j(relation.type);

    // Use dynamic relationship type via a workaround:
    // We store all relations as :KNOWLEDGE_REL with a relType property,
    // because APOC may not be available. If APOC is available, use dynamic types.
    const results = await this.cypher.write<{ r: any; created: boolean }>(
      `MATCH (src:${ENTITY_LABEL} { entityId: $sourceId })
       MATCH (tgt:${ENTITY_LABEL} { entityId: $targetId })
       MERGE (src)-[r:KNOWLEDGE_REL { relationId: $id }]->(tgt)
       ON CREATE SET
         r.relType = $relType,
         r.label = $label,
         r.properties_json = $props_json,
         r.weight = $weight,
         r.bidirectional = $bidirectional,
         r.confidence = $confidence,
         r.source_json = $source_json,
         r.validFrom = $validFrom,
         r.validTo = $validTo,
         r.createdAt = $now
       ON MATCH SET
         r.relType = $relType,
         r.label = $label,
         r.properties_json = $props_json,
         r.weight = $weight,
         r.bidirectional = $bidirectional,
         r.confidence = $confidence,
         r.source_json = $source_json,
         r.validFrom = $validFrom,
         r.validTo = $validTo
       RETURN r`,
      {
        id,
        sourceId: relation.sourceId,
        targetId: relation.targetId,
        relType,
        label: relation.label,
        props_json: relation.properties ? JSON.stringify(relation.properties) : null,
        weight: relation.weight,
        bidirectional: relation.bidirectional,
        confidence: relation.confidence,
        source_json: JSON.stringify(relation.source),
        validFrom: relation.validFrom ?? null,
        validTo: relation.validTo ?? null,
        now,
      },
    );

    return this.relToKnowledgeRelation(results[0]?.r, id, relation.sourceId, relation.targetId, now);
  }

  async getRelations(
    entityId: EntityId,
    options?: { direction?: 'outgoing' | 'incoming' | 'both'; types?: RelationType[] },
  ): Promise<KnowledgeRelation[]> {
    const direction = options?.direction ?? 'both';
    const types = options?.types?.map(relTypeToNeo4j);

    let cypher: string;
    const params: Record<string, unknown> = { entityId };

    if (types?.length) {
      params.types = types;
    }

    const typeFilter = types?.length ? 'AND r.relType IN $types' : '';

    if (direction === 'outgoing') {
      cypher = `MATCH (e:${ENTITY_LABEL} { entityId: $entityId })-[r:KNOWLEDGE_REL]->(t:${ENTITY_LABEL})
                WHERE true ${typeFilter}
                RETURN r, e.entityId AS srcId, t.entityId AS tgtId`;
    } else if (direction === 'incoming') {
      cypher = `MATCH (s:${ENTITY_LABEL})-[r:KNOWLEDGE_REL]->(e:${ENTITY_LABEL} { entityId: $entityId })
                WHERE true ${typeFilter}
                RETURN r, s.entityId AS srcId, e.entityId AS tgtId`;
    } else {
      cypher = `MATCH (e:${ENTITY_LABEL} { entityId: $entityId })-[r:KNOWLEDGE_REL]-(other:${ENTITY_LABEL})
                WHERE true ${typeFilter}
                RETURN r,
                  CASE WHEN startNode(r) = e THEN e.entityId ELSE other.entityId END AS srcId,
                  CASE WHEN endNode(r) = e THEN e.entityId ELSE other.entityId END AS tgtId`;
    }

    const results = await this.cypher.read<{ r: any; srcId: string; tgtId: string }>(cypher, params);
    return results.map((row) => this.relToKnowledgeRelation(row.r, undefined, row.srcId, row.tgtId));
  }

  async deleteRelation(id: RelationId): Promise<boolean> {
    const results = await this.cypher.write<{ deleted: number }>(
      `MATCH ()-[r:KNOWLEDGE_REL { relationId: $id }]->()
       DELETE r
       RETURN 1 AS deleted`,
      { id },
    );
    return results.length > 0;
  }

  // ============ Episodic Memory Operations ============

  /**
   * Record an episodic memory. A memory trace's copy (a context that names the trace, `memoryTraceId`) carries the
   * trace id (`traceId`, indexed) and replaces the copy recorded for the trace before.
   */
  async recordMemory(
    memory: Omit<EpisodicMemory, 'id' | 'createdAt' | 'accessCount' | 'lastAccessedAt'>,
  ): Promise<EpisodicMemory> {
    const id = generateId();
    const now = nowIso();
    const traceId = copiedTraceId(memory.context) ?? null;

    if (traceId !== null) {
      await this.cypher.writeVoid(`MATCH (m:${MEMORY_LABEL}) WHERE m.traceId = $traceId DETACH DELETE m`, { traceId });
    }
    await this.cypher.writeVoid(
      `CREATE (m:${MEMORY_LABEL} {
         memoryId: $id,
         traceId: $traceId,
         type: $type,
         summary: $summary,
         description: $description,
         participants: $participants,
         valence: $valence,
         importance: $importance,
         embedding: $embedding,
         occurredAt: $occurredAt,
         durationMs: $durationMs,
         outcome: $outcome,
         insights_json: $insights_json,
         context_json: $context_json,
         entityIds: $entityIds,
         createdAt: $now,
         accessCount: 0,
         lastAccessedAt: $now
       })`,
      {
        id,
        traceId,
        type: memory.type,
        summary: memory.summary,
        description: memory.description ?? null,
        participants: memory.participants,
        valence: memory.valence ?? null,
        importance: memory.importance,
        embedding: memory.embedding ?? null,
        occurredAt: memory.occurredAt,
        durationMs: memory.durationMs ?? null,
        outcome: memory.outcome ?? null,
        insights_json: memory.insights ? JSON.stringify(memory.insights) : null,
        context_json: memory.context ? JSON.stringify(memory.context) : null,
        entityIds: memory.entityIds,
        now,
      },
    );

    // Link to entities
    if (memory.entityIds.length > 0) {
      await this.cypher.writeVoid(
        `MATCH (m:${MEMORY_LABEL} { memoryId: $id })
         UNWIND $entityIds AS eid
         MATCH (e:${ENTITY_LABEL} { entityId: eid })
         MERGE (m)-[:REFERS_TO]->(e)`,
        { id, entityIds: memory.entityIds },
      );
    }

    return {
      id,
      ...memory,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    };
  }

  async getMemory(id: string): Promise<EpisodicMemory | undefined> {
    const results = await this.cypher.read<{ m: any }>(
      `MATCH (m:${MEMORY_LABEL} { memoryId: $id }) RETURN m`,
      { id },
    );
    if (results.length === 0) return undefined;

    // Update access count
    await this.cypher.writeVoid(
      `MATCH (m:${MEMORY_LABEL} { memoryId: $id })
       SET m.accessCount = m.accessCount + 1, m.lastAccessedAt = $now`,
      { id, now: nowIso() },
    );

    return this.nodeToMemory(results[0].m);
  }

  /**
   * Delete the episodic memories that copy the filter's traces or scopes. A trace's copies are read through their
   * trace id (`traceId`, indexed); the first delete by trace id of this graph first gives the copies an older release
   * recorded their trace id ({@link backfillCopyTraceIds}). A scope's copies are read by the text their stored context
   * JSON must hold (`CONTAINS`) and matched exactly in code, so a malformed `context_json` is skipped rather than
   * failing the delete.
   */
  async deleteMemories(filter: MemoryCopyFilter): Promise<number> {
    if (isEmptyCopyFilter(filter)) return 0;
    const ids = new Set<string>();
    const traceIds = filterTraceIds(filter);
    if (traceIds.length > 0) {
      await this.backfillCopyTraceIds();
      const rows = await this.cypher.read<{ id: string }>(
        `MATCH (m:${MEMORY_LABEL}) WHERE m.traceId IN $traceIds RETURN m.memoryId AS id`,
        { traceIds },
      );
      for (const row of rows) ids.add(row.id);
    }
    const scopes = filter.scopes ?? [];
    if (scopes.length > 0) {
      const byScope: MemoryCopyFilter = { scopes };
      const rows = await this.cypher.read<{ id: string; context: string | null }>(
        `MATCH (m:${MEMORY_LABEL})
         WHERE m.context_json IS NOT NULL AND any(needle IN $needles WHERE m.context_json CONTAINS needle)
         RETURN m.memoryId AS id, m.context_json AS context`,
        { needles: scopeNeedles(scopes) },
      );
      for (const row of rows) {
        if (isMemoryCopyOf(this.safeParseJson(row.context, undefined), byScope)) ids.add(row.id);
      }
    }
    if (ids.size === 0) return 0;
    await this.cypher.writeVoid(`MATCH (m:${MEMORY_LABEL}) WHERE m.memoryId IN $ids DETACH DELETE m`, { ids: [...ids] });
    return ids.size;
  }

  /**
   * Give the trace copies an older release recorded, which carry no `traceId`, the trace id their stored context
   * names, once per graph, so a delete by trace id finds them through the index. A pass that fails is made again at
   * the next delete by trace id. A copy an older release writes after the pass gets its trace id from the next
   * graph's pass; until then a delete by its scope finds it.
   */
  private backfillCopyTraceIds(): Promise<void> {
    if (!this.copyTraceIdsBackfilled) {
      this.copyTraceIdsBackfilled = this.writeCopyTraceIds().catch((error: unknown) => {
        this.copyTraceIdsBackfilled = null;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Neo4jKnowledgeGraph] giving older trace copies their trace id failed; a delete by trace id misses them ` +
            `until the next one tries again: ${message}`,
        );
      });
    }
    return this.copyTraceIdsBackfilled;
  }

  private async writeCopyTraceIds(): Promise<void> {
    const rows = await this.cypher.read<{ id: string; context: string | null }>(
      `MATCH (m:${MEMORY_LABEL})
       WHERE m.traceId IS NULL AND m.context_json CONTAINS $marker
       RETURN m.memoryId AS id, m.context_json AS context`,
      { marker: TRACE_CONTEXT_MARKER },
    );
    const copies = rows.flatMap((row) => {
      const traceId = copiedTraceId(this.safeParseJson(row.context, undefined));
      return traceId === undefined ? [] : [{ id: row.id, traceId }];
    });
    for (let offset = 0; offset < copies.length; offset += 1000) {
      await this.cypher.writeVoid(
        `UNWIND $copies AS copy
         MATCH (m:${MEMORY_LABEL} { memoryId: copy.id })
         SET m.traceId = copy.traceId`,
        { copies: copies.slice(offset, offset + 1000) },
      );
    }
  }

  async queryMemories(options?: {
    types?: EpisodicMemory['type'][];
    participants?: string[];
    minImportance?: number;
    timeRange?: { from?: string; to?: string };
    limit?: number;
  }): Promise<EpisodicMemory[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (options?.types?.length) {
      conditions.push('m.type IN $types');
      params.types = options.types;
    }
    if (options?.participants?.length) {
      conditions.push('ANY(p IN $participants WHERE p IN m.participants)');
      params.participants = options.participants;
    }
    if (options?.minImportance !== undefined) {
      conditions.push('m.importance >= $minImportance');
      params.minImportance = options.minImportance;
    }
    if (options?.timeRange?.from) {
      conditions.push('m.occurredAt >= $from');
      params.from = options.timeRange.from;
    }
    if (options?.timeRange?.to) {
      conditions.push('m.occurredAt <= $to');
      params.to = options.timeRange.to;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 50;

    const results = await this.cypher.read<{ m: any }>(
      `MATCH (m:${MEMORY_LABEL}) ${where}
       RETURN m ORDER BY m.importance DESC, m.occurredAt DESC LIMIT $limit`,
      { ...params, limit },
    );

    return results.map((r) => this.nodeToMemory(r.m));
  }

  async recallMemories(query: string, topK?: number): Promise<EpisodicMemory[]> {
    // This requires embedding the query first — for now, do text-based recall
    // When embedding manager is wired, this will use vector search
    const k = topK ?? 5;
    const results = await this.cypher.read<{ m: any }>(
      `MATCH (m:${MEMORY_LABEL})
       WHERE m.summary CONTAINS $query OR m.description CONTAINS $query
       RETURN m ORDER BY m.importance DESC LIMIT $k`,
      { query, k },
    );

    // Update access counts
    const ids = results.map((r) => r.m.properties?.memoryId ?? r.m.memoryId);
    if (ids.length > 0) {
      await this.cypher.writeVoid(
        `MATCH (m:${MEMORY_LABEL}) WHERE m.memoryId IN $ids
         SET m.accessCount = m.accessCount + 1, m.lastAccessedAt = $now`,
        { ids, now: nowIso() },
      );
    }

    return results.map((r) => this.nodeToMemory(r.m));
  }

  // ============ Graph Traversal ============

  async traverse(startEntityId: EntityId, options?: TraversalOptions): Promise<TraversalResult> {
    const maxDepth = options?.maxDepth ?? 3;
    const maxNodes = options?.maxNodes ?? 100;
    const minWeight = options?.minWeight ?? 0;
    const direction = options?.direction ?? 'both';
    const relTypes = options?.relationTypes?.map(relTypeToNeo4j);

    // Get root entity
    const rootResults = await this.cypher.read<{ e: any }>(
      `MATCH (e:${ENTITY_LABEL} { entityId: $id }) RETURN e`,
      { id: startEntityId },
    );
    if (rootResults.length === 0) {
      throw new Error(`Entity not found: ${startEntityId}`);
    }
    const root = this.nodeToEntity(rootResults[0].e);

    // Build direction pattern
    let pattern: string;
    if (direction === 'outgoing') pattern = '(start)-[r:KNOWLEDGE_REL*1..maxD]->(neighbor)';
    else if (direction === 'incoming') pattern = '(start)<-[r:KNOWLEDGE_REL*1..maxD]-(neighbor)';
    else pattern = '(start)-[r:KNOWLEDGE_REL*1..maxD]-(neighbor)';

    // Replace maxD placeholder
    pattern = pattern.replace('maxD', String(maxDepth));

    const typeFilter = relTypes?.length
      ? 'AND ALL(rel IN relationships(path) WHERE rel.relType IN $relTypes)'
      : '';
    const weightFilter = minWeight > 0
      ? 'AND ALL(rel IN relationships(path) WHERE rel.weight >= $minWeight)'
      : '';

    const results = await this.cypher.read<{
      neighbor: any;
      depth: number;
      rels: any[];
    }>(
      `MATCH (start:${ENTITY_LABEL} { entityId: $startId })
       MATCH path = ${pattern}
       WHERE neighbor <> start
       ${typeFilter}
       ${weightFilter}
       WITH neighbor, min(length(path)) AS depth, relationships(path) AS rels
       RETURN neighbor, depth, rels
       ORDER BY depth ASC
       LIMIT $maxNodes`,
      {
        startId: startEntityId,
        relTypes: relTypes ?? [],
        minWeight,
        maxNodes,
      },
    );

    // Organize by depth levels
    const levelMap = new Map<number, { entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }>();
    for (const row of results) {
      const depth = typeof row.depth === 'object' ? Number((row.depth as any).low ?? row.depth) : Number(row.depth);
      if (!levelMap.has(depth)) {
        levelMap.set(depth, { entities: [], relations: [] });
      }
      const level = levelMap.get(depth)!;
      level.entities.push(this.nodeToEntity(row.neighbor));
    }

    const levels = Array.from(levelMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([depth, data]) => ({ depth, ...data }));

    return {
      root,
      levels,
      totalEntities: results.length,
      totalRelations: results.reduce((sum, r) => sum + (r.rels?.length ?? 0), 0),
    };
  }

  async findPath(
    sourceId: EntityId,
    targetId: EntityId,
    maxDepth?: number,
  ): Promise<Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> | null> {
    const max = maxDepth ?? 10;

    const results = await this.cypher.read<{ pathNodes: any[]; pathRels: any[] }>(
      `MATCH (src:${ENTITY_LABEL} { entityId: $sourceId }),
            (tgt:${ENTITY_LABEL} { entityId: $targetId })
       MATCH path = shortestPath((src)-[:KNOWLEDGE_REL*1..${max}]-(tgt))
       RETURN [n IN nodes(path) | n] AS pathNodes,
              [r IN relationships(path) | r] AS pathRels`,
      { sourceId, targetId },
    );

    if (results.length === 0) return null;

    const { pathNodes, pathRels } = results[0];
    const result: Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> = [];

    for (let i = 0; i < pathNodes.length; i++) {
      const entry: { entity: KnowledgeEntity; relation?: KnowledgeRelation } = {
        entity: this.nodeToEntity(pathNodes[i]),
      };
      if (i < pathRels.length) {
        entry.relation = this.relPropsToKnowledgeRelation(pathRels[i]);
      }
      result.push(entry);
    }

    return result;
  }

  async getNeighborhood(
    entityId: EntityId,
    depth?: number,
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    const d = depth ?? 1;

    const results = await this.cypher.read<{ n: any; r: any }>(
      `MATCH (e:${ENTITY_LABEL} { entityId: $entityId })-[r:KNOWLEDGE_REL*1..${d}]-(n:${ENTITY_LABEL})
       WHERE n <> e
       UNWIND r AS rel
       WITH DISTINCT n, rel
       RETURN n, rel`,
      { entityId },
    );

    const entityMap = new Map<string, KnowledgeEntity>();
    const relations: KnowledgeRelation[] = [];

    for (const row of results) {
      const entity = this.nodeToEntity(row.n);
      entityMap.set(entity.id, entity);
      if (row.r) {
        relations.push(this.relPropsToKnowledgeRelation(row.r));
      }
    }

    return {
      entities: Array.from(entityMap.values()),
      relations,
    };
  }

  // ============ Semantic Search ============

  async semanticSearch(options: SemanticSearchOptions): Promise<SemanticSearchResult[]> {
    // Without embedding manager here, we fall back to text-based search.
    // When the caller provides query embeddings via the full stack, vector search is used.
    const topK = options.topK ?? 10;
    const minSim = options.minSimilarity ?? 0;
    const results: SemanticSearchResult[] = [];

    const scope = options.scope ?? 'all';

    if (scope === 'entities' || scope === 'all') {
      const conditions: string[] = [];
      const params: Record<string, unknown> = { query: options.query, limit: topK };

      if (options.entityTypes?.length) {
        conditions.push('e.type IN $entityTypes');
        params.entityTypes = options.entityTypes;
      }
      if (options.ownerId) {
        conditions.push('e.ownerId = $ownerId');
        params.ownerId = options.ownerId;
      }

      const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

      const entityResults = await this.cypher.read<{ e: any }>(
        `MATCH (e:${ENTITY_LABEL})
         WHERE (e.label CONTAINS $query OR e.properties_json CONTAINS $query) ${where}
         RETURN e LIMIT $limit`,
        params,
      );

      for (const row of entityResults) {
        results.push({
          item: this.nodeToEntity(row.e),
          type: 'entity',
          similarity: 0.5, // Placeholder — real score from vector search
        });
      }
    }

    if (scope === 'memories' || scope === 'all') {
      const memResults = await this.cypher.read<{ m: any }>(
        `MATCH (m:${MEMORY_LABEL})
         WHERE m.summary CONTAINS $query OR m.description CONTAINS $query
         RETURN m LIMIT $limit`,
        { query: options.query, limit: topK },
      );

      for (const row of memResults) {
        results.push({
          item: this.nodeToMemory(row.m),
          type: 'memory',
          similarity: 0.5,
        });
      }
    }

    return results
      .filter((r) => r.similarity >= minSim)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  // ============ Knowledge Extraction ============

  async extractFromText(
    _text: string,
    _options?: { extractRelations?: boolean; entityTypes?: EntityType[] },
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    // Extraction requires LLM — this is a placeholder.
    // The actual extraction pipeline lives in the orchestration layer.
    return { entities: [], relations: [] };
  }

  // ============ Maintenance ============

  async mergeEntities(entityIds: EntityId[], primaryId: EntityId): Promise<KnowledgeEntity> {
    // Redirect all relations from secondary entities to primary
    const secondaryIds = entityIds.filter((id) => id !== primaryId);

    for (const secId of secondaryIds) {
      // Outgoing relations: sec -> target becomes primary -> target
      await this.cypher.writeVoid(
        `MATCH (sec:${ENTITY_LABEL} { entityId: $secId })-[r:KNOWLEDGE_REL]->(tgt:${ENTITY_LABEL})
         MATCH (primary:${ENTITY_LABEL} { entityId: $primaryId })
         WHERE NOT (primary)-[:KNOWLEDGE_REL]->(tgt)
         CREATE (primary)-[r2:KNOWLEDGE_REL]->(tgt)
         SET r2 = properties(r)
         DELETE r`,
        { secId, primaryId },
      );

      // Incoming relations: source -> sec becomes source -> primary
      await this.cypher.writeVoid(
        `MATCH (src:${ENTITY_LABEL})-[r:KNOWLEDGE_REL]->(sec:${ENTITY_LABEL} { entityId: $secId })
         MATCH (primary:${ENTITY_LABEL} { entityId: $primaryId })
         WHERE NOT (src)-[:KNOWLEDGE_REL]->(primary)
         CREATE (src)-[r2:KNOWLEDGE_REL]->(primary)
         SET r2 = properties(r)
         DELETE r`,
        { secId, primaryId },
      );

      // Memory links: memory -> sec becomes memory -> primary
      await this.cypher.writeVoid(
        `MATCH (m:${MEMORY_LABEL})-[r:REFERS_TO]->(sec:${ENTITY_LABEL} { entityId: $secId })
         MATCH (primary:${ENTITY_LABEL} { entityId: $primaryId })
         MERGE (m)-[:REFERS_TO]->(primary)
         DELETE r`,
        { secId, primaryId },
      );

      // Delete secondary entity
      await this.cypher.writeVoid(
        `MATCH (sec:${ENTITY_LABEL} { entityId: $secId }) DETACH DELETE sec`,
        { secId },
      );
    }

    const entity = await this.getEntity(primaryId);
    if (!entity) throw new Error(`Primary entity not found: ${primaryId}`);
    return entity;
  }

  async decayMemories(decayFactor?: number): Promise<number> {
    const factor = decayFactor ?? this.memoryDecayRate;
    const threshold = this.minImportanceThreshold;

    const results = await this.cypher.write<{ decayedCount: number }>(
      `MATCH (m:${MEMORY_LABEL})
       WHERE m.importance > $threshold
       WITH m,
            duration.between(datetime(m.lastAccessedAt), datetime()).days AS ageDays
       SET m.importance = m.importance * (1.0 - $factor) + log(toFloat(m.accessCount + 1)) * 0.1
       WITH m WHERE m.importance <= $threshold
       DETACH DELETE m
       RETURN count(m) AS decayedCount`,
      { factor, threshold },
    );

    return Number(results[0]?.decayedCount ?? 0);
  }

  async getStats(): Promise<KnowledgeGraphStats> {
    const results = await this.cypher.read<{
      totalEntities: number;
      totalRelations: number;
      totalMemories: number;
      avgConfidence: number;
      oldest: string;
      newest: string;
    }>(
      `MATCH (e:${ENTITY_LABEL})
       WITH count(e) AS totalEntities,
            avg(e.confidence) AS avgConfidence,
            min(e.createdAt) AS oldest,
            max(e.createdAt) AS newest
       OPTIONAL MATCH ()-[r:KNOWLEDGE_REL]->()
       WITH totalEntities, avgConfidence, oldest, newest, count(r) AS totalRelations
       OPTIONAL MATCH (m:${MEMORY_LABEL})
       RETURN totalEntities, totalRelations, count(m) AS totalMemories,
              avgConfidence, oldest, newest`,
    );

    const row = results[0] ?? {};

    // Entity type counts
    const typeCounts = await this.cypher.read<{ type: string; count: number }>(
      `MATCH (e:${ENTITY_LABEL}) RETURN e.type AS type, count(e) AS count`,
    );
    const entitiesByType: Record<string, number> = {};
    for (const tc of typeCounts) {
      entitiesByType[tc.type] = Number(tc.count);
    }

    // Relation type counts
    const relCounts = await this.cypher.read<{ type: string; count: number }>(
      `MATCH ()-[r:KNOWLEDGE_REL]->() RETURN r.relType AS type, count(r) AS count`,
    );
    const relationsByType: Record<string, number> = {};
    for (const rc of relCounts) {
      relationsByType[neo4jToRelType(rc.type)] = Number(rc.count);
    }

    return {
      totalEntities: Number(row.totalEntities ?? 0),
      totalRelations: Number(row.totalRelations ?? 0),
      totalMemories: Number(row.totalMemories ?? 0),
      entitiesByType: entitiesByType as Record<EntityType, number>,
      relationsByType: relationsByType as Record<RelationType, number>,
      avgConfidence: Number(row.avgConfidence ?? 0),
      oldestEntry: row.oldest ?? '',
      newestEntry: row.newest ?? '',
    };
  }

  async clear(): Promise<void> {
    await this.cypher.writeVoid(`MATCH (n:${ENTITY_LABEL}) DETACH DELETE n`);
    await this.cypher.writeVoid(`MATCH (n:${MEMORY_LABEL}) DETACH DELETE n`);
  }

  // ============ Private Helpers ============

  private nodeToEntity(node: any, fallbackId?: string, fallbackNow?: string): KnowledgeEntity {
    const props = node?.properties ?? node ?? {};
    return {
      id: props.entityId ?? fallbackId ?? '',
      type: props.type ?? 'custom',
      label: props.label ?? '',
      properties: this.safeParseJson(props.properties_json, {}),
      embedding: props.embedding ?? undefined,
      confidence: Number(props.confidence ?? 0),
      source: this.safeParseJson(props.source_json, { type: 'system', timestamp: '' }),
      createdAt: props.createdAt ?? fallbackNow ?? '',
      updatedAt: props.updatedAt ?? fallbackNow ?? '',
      ownerId: props.ownerId ?? undefined,
      tags: props.tags ?? [],
      metadata: props.metadata_json ? this.safeParseJson(props.metadata_json, undefined) : undefined,
    };
  }

  private nodeToMemory(node: any): EpisodicMemory {
    const props = node?.properties ?? node ?? {};
    return {
      id: props.memoryId ?? '',
      type: props.type ?? 'interaction',
      summary: props.summary ?? '',
      description: props.description ?? undefined,
      participants: props.participants ?? [],
      valence: props.valence ?? undefined,
      importance: Number(props.importance ?? 0),
      entityIds: props.entityIds ?? [],
      embedding: props.embedding ?? undefined,
      occurredAt: props.occurredAt ?? '',
      durationMs: props.durationMs ? Number(props.durationMs) : undefined,
      outcome: props.outcome ?? undefined,
      insights: props.insights_json ? this.safeParseJson(props.insights_json, []) : undefined,
      context: props.context_json ? this.safeParseJson(props.context_json, undefined) : undefined,
      createdAt: props.createdAt ?? '',
      accessCount: Number(props.accessCount ?? 0),
      lastAccessedAt: props.lastAccessedAt ?? '',
    };
  }

  private relToKnowledgeRelation(
    rel: any,
    fallbackId?: string,
    fallbackSrcId?: string,
    fallbackTgtId?: string,
    fallbackNow?: string,
  ): KnowledgeRelation {
    const props = rel?.properties ?? rel ?? {};
    return {
      id: props.relationId ?? fallbackId ?? '',
      sourceId: fallbackSrcId ?? '',
      targetId: fallbackTgtId ?? '',
      type: neo4jToRelType(props.relType ?? 'RELATED_TO'),
      label: props.label ?? '',
      properties: props.properties_json ? this.safeParseJson(props.properties_json, {}) : undefined,
      weight: Number(props.weight ?? 0),
      bidirectional: Boolean(props.bidirectional),
      confidence: Number(props.confidence ?? 0),
      source: this.safeParseJson(props.source_json, { type: 'system', timestamp: '' }),
      createdAt: props.createdAt ?? fallbackNow ?? '',
      validFrom: props.validFrom ?? undefined,
      validTo: props.validTo ?? undefined,
    };
  }

  private relPropsToKnowledgeRelation(rel: any): KnowledgeRelation {
    const props = rel?.properties ?? rel ?? {};
    return {
      id: props.relationId ?? '',
      sourceId: '',
      targetId: '',
      type: neo4jToRelType(props.relType ?? 'RELATED_TO'),
      label: props.label ?? '',
      properties: props.properties_json ? this.safeParseJson(props.properties_json, {}) : undefined,
      weight: Number(props.weight ?? 0),
      bidirectional: Boolean(props.bidirectional),
      confidence: Number(props.confidence ?? 0),
      source: this.safeParseJson(props.source_json, { type: 'system', timestamp: '' }),
      createdAt: props.createdAt ?? '',
      validFrom: props.validFrom ?? undefined,
      validTo: props.validTo ?? undefined,
    };
  }

  private safeParseJson(json: string | null | undefined, fallback: any): any {
    if (!json) return fallback;
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }
}
