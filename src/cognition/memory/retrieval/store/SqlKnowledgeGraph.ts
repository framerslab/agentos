/**
 * @fileoverview SQLite-backed implementation of IKnowledgeGraph.
 *
 * Persists knowledge entities (nodes), relations (edges), and episodic memories
 * to the `knowledge_nodes` and `knowledge_edges` tables managed by Brain.
 *
 * Uses the async StorageAdapter API exposed by Brain (run/get/all/exec/
 * transaction) rather than direct better-sqlite3 access.
 *
 * Episodic memories are stored as knowledge_nodes with `type = 'memory'` and
 * their memory-specific fields packed into the `properties` JSON column.
 *
 * Graph traversal (BFS/DFS, shortest path, neighbourhood) is implemented via
 * SQLite recursive Common Table Expressions (CTEs).
 *
 * Semantic search loads embeddings from BLOB columns and computes cosine
 * similarity in-process — no external vector DB needed for the SQLite path.
 *
 * @module memory/store/SqlKnowledgeGraph
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
  KnowledgeSource,
  MemoryCopyFilter,
} from '../graph/knowledge/IKnowledgeGraph.js';
import { copyNeedles, isEmptyCopyFilter, isMemoryCopyOf } from '../graph/knowledge/memoryCopies.js';
import type { Brain } from './Brain.js';
import { uuid } from '../../core/util/crossPlatformCrypto.js';

// ---------------------------------------------------------------------------
// Internal row shapes (what SQLite returns)
// ---------------------------------------------------------------------------

/** Shape of a row returned from the knowledge_nodes table. */
interface NodeRow {
  id: string;
  type: string;
  label: string;
  properties: string;
  embedding: Uint8Array | null;
  confidence: number;
  source: string;
  created_at: number;
}

/** Shape of a row returned from the knowledge_edges table. */
interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  bidirectional: number;
  metadata: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helper: pack / unpack extended entity fields into `properties` JSON
// ---------------------------------------------------------------------------

/**
 * Extended fields that live inside the `properties` JSON column because the
 * physical schema only has: id, type, label, properties, embedding, confidence,
 * source, created_at.
 */
interface ExtendedNodeFields {
  /** The entity's own properties map. */
  _props: Record<string, unknown>;
  /** Owner / GMI ID. */
  _ownerId?: string;
  /** Tags array. */
  _tags?: string[];
  /** Arbitrary metadata. */
  _metadata?: Record<string, unknown>;
  /** ISO 8601 updated-at timestamp. */
  _updatedAt: string;
}

/**
 * Extended fields packed into the `metadata` JSON column on edges because the
 * physical schema only has: id, source_id, target_id, type, weight,
 * bidirectional, metadata, created_at.
 */
interface ExtendedEdgeFields {
  /** Edge label (human-readable). */
  _label: string;
  /** Edge-level properties. */
  _properties?: Record<string, unknown>;
  /** Confidence score. */
  _confidence: number;
  /** Source provenance. */
  _source: KnowledgeSource;
  /** Temporal validity start. */
  _validFrom?: string;
  /** Temporal validity end. */
  _validTo?: string;
}

/**
 * Extended fields packed into `properties` for memory-type nodes.
 * Extends `ExtendedNodeFields` with episodic-memory-specific data.
 */
interface MemoryNodeFields extends ExtendedNodeFields {
  /** Episodic memory sub-type. */
  _memoryType: EpisodicMemory['type'];
  /** Summary text. */
  _summary: string;
  /** Detailed description. */
  _description?: string;
  /** Participant IDs. */
  _participants: string[];
  /** Emotional valence (-1 to 1). */
  _valence?: number;
  /** Importance score (0-1). */
  _importance: number;
  /** Linked entity IDs. */
  _entityIds: string[];
  /** When the episode occurred (ISO 8601). */
  _occurredAt: string;
  /** Duration in milliseconds. */
  _durationMs?: number;
  /** Outcome tag. */
  _outcome?: 'success' | 'failure' | 'partial' | 'unknown';
  /** Lessons learned. */
  _insights?: string[];
  /** Raw context data. */
  _context?: Record<string, unknown>;
  /** Access counter. */
  _accessCount: number;
  /** Last accessed ISO 8601 timestamp. */
  _lastAccessedAt: string;
}

// ---------------------------------------------------------------------------
// SqlKnowledgeGraph
// ---------------------------------------------------------------------------

/**
 * Persistent knowledge graph backed by SQLite via Brain.
 *
 * Implements the full `IKnowledgeGraph` interface using the `knowledge_nodes`
 * and `knowledge_edges` tables. Extended entity/relation fields that don't
 * have dedicated columns are serialized into the JSON `properties` / `metadata`
 * columns.
 *
 * @example
 * ```ts
 * const brain = await Brain.openSqlite('/tmp/agent-brain.sqlite');
 * const graph = new SqlKnowledgeGraph(brain);
 * await graph.initialize();
 *
 * const entity = await graph.upsertEntity({
 *   type: 'person',
 *   label: 'Alice',
 *   properties: { role: 'engineer' },
 *   confidence: 0.95,
 *   source: { type: 'user_input', timestamp: new Date().toISOString() },
 * });
 * ```
 */
export class SqlKnowledgeGraph implements IKnowledgeGraph {
  /** The shared SQLite brain instance. */
  private readonly brain: Brain;

  /**
   * @param brain - A Brain instance whose async StorageAdapter methods
   *                are used for all queries.
   */
  constructor(brain: Brain) {
    this.brain = brain;
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Initialize the knowledge graph.
   *
   * The schema is already created by Brain's constructor, so this is
   * effectively a no-op. Provided to satisfy the IKnowledgeGraph contract.
   */
  async initialize(): Promise<void> {
    // Schema already exists via Brain._initSchema().
    // Nothing additional to do.
  }

  // =========================================================================
  // Entity Operations
  // =========================================================================

  /**
   * Insert or update a knowledge entity.
   *
   * If `entity.id` is provided and exists, the row is updated (INSERT OR REPLACE).
   * If omitted, a new UUID is generated.
   *
   * Extended fields (ownerId, tags, metadata, updatedAt) are packed into the
   * `properties` JSON column as underscore-prefixed keys to avoid collisions
   * with user-supplied properties.
   */
  async upsertEntity(
    entity: Omit<KnowledgeEntity, 'id' | 'createdAt' | 'updatedAt'> & { id?: EntityId },
  ): Promise<KnowledgeEntity> {
    const now = new Date().toISOString();
    const id = entity.id ?? uuid();

    // Check if the entity already exists to preserve createdAt.
    const existing = await this.brain.get<NodeRow>(
      'SELECT * FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
      [this.brain.brainId, id],
    );

    const createdAt = existing
      ? new Date(existing.created_at).toISOString()
      : now;

    // Pack extended fields into the properties JSON envelope.
    const extended: ExtendedNodeFields = {
      _props: entity.properties,
      _ownerId: entity.ownerId,
      _tags: entity.tags,
      _metadata: entity.metadata,
      _updatedAt: now,
    };

    const embeddingBlob = entity.embedding
      ? this.brain.features.blobCodec.encode(entity.embedding)
      : null;

    const { dialect } = this.brain.features;
    await this.brain.run(
      dialect.insertOrReplace(
        'knowledge_nodes',
        ['brain_id', 'id', 'type', 'label', 'properties', 'embedding', 'confidence', 'source', 'created_at'],
        ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
        'brain_id, id',
      ),
      [
        this.brain.brainId,
        id,
        entity.type,
        entity.label,
        JSON.stringify(extended),
        embeddingBlob,
        entity.confidence,
        JSON.stringify(entity.source),
        new Date(createdAt).getTime(),
      ],
    );

    return this._rowToEntity({
      id,
      type: entity.type,
      label: entity.label,
      properties: JSON.stringify(extended),
      embedding: embeddingBlob,
      confidence: entity.confidence,
      source: JSON.stringify(entity.source),
      created_at: new Date(createdAt).getTime(),
    });
  }

  /**
   * Retrieve a single entity by its ID.
   * Returns `undefined` if the entity does not exist.
   */
  async getEntity(id: EntityId): Promise<KnowledgeEntity | undefined> {
    const row = await this.brain.get<NodeRow>(
      'SELECT * FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
      [this.brain.brainId, id],
    );

    if (!row) return undefined;
    return this._rowToEntity(row);
  }

  /**
   * Query entities with optional filters.
   *
   * Supports filtering by entity type, tags, owner, minimum confidence,
   * full-text search, pagination (limit/offset), and time ranges.
   */
  async queryEntities(options?: KnowledgeQueryOptions): Promise<KnowledgeEntity[]> {
    const clauses: string[] = ['brain_id = ?'];
    const params: unknown[] = [this.brain.brainId];

    // Filter: entity types (only non-memory types for queryEntities).
    if (options?.entityTypes && options.entityTypes.length > 0) {
      const placeholders = options.entityTypes.map(() => '?').join(', ');
      clauses.push(`type IN (${placeholders})`);
      params.push(...options.entityTypes);
    }

    // Filter: minimum confidence.
    if (options?.minConfidence !== undefined) {
      clauses.push('confidence >= ?');
      params.push(options.minConfidence);
    }

    // Filter: time range.
    if (options?.timeRange?.from) {
      clauses.push('created_at >= ?');
      params.push(new Date(options.timeRange.from).getTime());
    }
    if (options?.timeRange?.to) {
      clauses.push('created_at <= ?');
      params.push(new Date(options.timeRange.to).getTime());
    }

    // brain_id always present in clauses so WHERE is unconditional.
    const whereClause = `WHERE ${clauses.join(' AND ')}`;
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const sql = `SELECT * FROM knowledge_nodes ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await this.brain.all<NodeRow>(sql, params);

    let entities = rows.map((r) => this._rowToEntity(r));

    // Post-filter by ownerId (stored inside properties JSON).
    if (options?.ownerId) {
      entities = entities.filter((e) => e.ownerId === options.ownerId);
    }

    // Post-filter by tags (stored inside properties JSON).
    if (options?.tags && options.tags.length > 0) {
      entities = entities.filter((e) =>
        options.tags!.some((tag) => e.tags?.includes(tag)),
      );
    }

    // Post-filter by textSearch (label + properties text match, case-insensitive).
    if ((options as KnowledgeQueryOptions & { textSearch?: string })?.textSearch) {
      const search = ((options as KnowledgeQueryOptions & { textSearch?: string }).textSearch as string).toLowerCase();
      entities = entities.filter(
        (e) =>
          e.label.toLowerCase().includes(search) ||
          JSON.stringify(e.properties).toLowerCase().includes(search),
      );
    }

    return entities;
  }

  /**
   * Delete an entity and all its associated relations (incoming and outgoing).
   * Returns `true` if the entity existed and was deleted.
   */
  async deleteEntity(id: EntityId): Promise<boolean> {
    const brainId = this.brain.brainId;
    return await this.brain.transaction(async (trx) => {
      // Delete all edges touching this entity.
      await trx.run(
        'DELETE FROM knowledge_edges WHERE brain_id = ? AND (source_id = ? OR target_id = ?)',
        [brainId, id, id],
      );

      // Delete the node itself.
      const result = await trx.run(
        'DELETE FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
        [brainId, id],
      );

      return result.changes > 0;
    });
  }

  // =========================================================================
  // Relation Operations
  // =========================================================================

  /**
   * Insert or update a knowledge relation (edge).
   *
   * Extended edge fields (label, properties, confidence, source, validFrom,
   * validTo) are packed into the `metadata` JSON column.
   */
  async upsertRelation(
    relation: Omit<KnowledgeRelation, 'id' | 'createdAt'> & { id?: RelationId },
  ): Promise<KnowledgeRelation> {
    const now = new Date().toISOString();
    const id = relation.id ?? uuid();

    // Preserve createdAt if edge already exists.
    const existing = await this.brain.get<EdgeRow>(
      'SELECT * FROM knowledge_edges WHERE brain_id = ? AND id = ?',
      [this.brain.brainId, id],
    );

    const createdAt = existing
      ? new Date(existing.created_at).toISOString()
      : now;

    // Pack extended edge fields into the metadata JSON column.
    const extended: ExtendedEdgeFields = {
      _label: relation.label,
      _properties: relation.properties,
      _confidence: relation.confidence,
      _source: relation.source,
      _validFrom: relation.validFrom,
      _validTo: relation.validTo,
    };

    const { dialect } = this.brain.features;
    await this.brain.run(
      dialect.insertOrReplace(
        'knowledge_edges',
        ['brain_id', 'id', 'source_id', 'target_id', 'type', 'weight', 'bidirectional', 'metadata', 'created_at'],
        ['?', '?', '?', '?', '?', '?', '?', '?', '?'],
        'brain_id, id',
      ),
      [
        this.brain.brainId,
        id,
        relation.sourceId,
        relation.targetId,
        relation.type,
        relation.weight,
        relation.bidirectional ? 1 : 0,
        JSON.stringify(extended),
        new Date(createdAt).getTime(),
      ],
    );

    return this._rowToRelation({
      id,
      source_id: relation.sourceId,
      target_id: relation.targetId,
      type: relation.type,
      weight: relation.weight,
      bidirectional: relation.bidirectional ? 1 : 0,
      metadata: JSON.stringify(extended),
      created_at: new Date(createdAt).getTime(),
    });
  }

  /**
   * Get all relations for a given entity.
   *
   * @param entityId - The entity whose relations to retrieve.
   * @param options  - Optional filters: direction ('outgoing'|'incoming'|'both'), types.
   */
  async getRelations(
    entityId: EntityId,
    options?: { direction?: 'outgoing' | 'incoming' | 'both'; types?: RelationType[] },
  ): Promise<KnowledgeRelation[]> {
    const direction = options?.direction ?? 'both';

    const clauses: string[] = ['brain_id = ?'];
    const params: unknown[] = [this.brain.brainId];

    if (direction === 'outgoing') {
      clauses.push('(source_id = ?)');
      params.push(entityId);
    } else if (direction === 'incoming') {
      clauses.push('(target_id = ?)');
      params.push(entityId);
    } else {
      clauses.push('(source_id = ? OR target_id = ?)');
      params.push(entityId, entityId);
    }

    if (options?.types && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(', ');
      clauses.push(`type IN (${placeholders})`);
      params.push(...options.types);
    }

    const sql = `SELECT * FROM knowledge_edges WHERE ${clauses.join(' AND ')}`;
    const rows = await this.brain.all<EdgeRow>(sql, params);

    return rows.map((r) => this._rowToRelation(r));
  }

  /**
   * Delete a single relation by its ID.
   * Returns `true` if the relation existed and was deleted.
   */
  async deleteRelation(id: RelationId): Promise<boolean> {
    const result = await this.brain.run(
      'DELETE FROM knowledge_edges WHERE brain_id = ? AND id = ?',
      [this.brain.brainId, id],
    );
    return result.changes > 0;
  }

  // =========================================================================
  // Episodic Memory Operations
  // =========================================================================

  /**
   * Record an episodic memory.
   *
   * Memories are stored as knowledge_nodes with `type = 'memory'`. The
   * memory-specific fields are packed into the `properties` JSON column.
   */
  async recordMemory(
    memory: Omit<EpisodicMemory, 'id' | 'createdAt' | 'accessCount' | 'lastAccessedAt'>,
  ): Promise<EpisodicMemory> {
    const now = new Date().toISOString();
    const id = uuid();

    const memFields: MemoryNodeFields = {
      _props: {},
      _updatedAt: now,
      _memoryType: memory.type,
      _summary: memory.summary,
      _description: memory.description,
      _participants: memory.participants,
      _valence: memory.valence,
      _importance: memory.importance,
      _entityIds: memory.entityIds,
      _occurredAt: memory.occurredAt,
      _durationMs: memory.durationMs,
      _outcome: memory.outcome,
      _insights: memory.insights,
      _context: memory.context,
      _accessCount: 0,
      _lastAccessedAt: now,
    };

    const embeddingBlob = memory.embedding
      ? this.brain.features.blobCodec.encode(memory.embedding)
      : null;

    const source: KnowledgeSource = {
      type: 'conversation',
      timestamp: now,
    };

    await this.brain.run(
      `INSERT INTO knowledge_nodes
         (brain_id, id, type, label, properties, embedding, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.brain.brainId,
        id,
        'memory',
        memory.summary.slice(0, 200),
        JSON.stringify(memFields),
        embeddingBlob,
        memory.importance,
        JSON.stringify(source),
        new Date(now).getTime(),
      ],
    );

    return {
      id,
      type: memory.type,
      summary: memory.summary,
      description: memory.description,
      participants: memory.participants,
      valence: memory.valence,
      importance: memory.importance,
      entityIds: memory.entityIds,
      embedding: memory.embedding,
      occurredAt: memory.occurredAt,
      durationMs: memory.durationMs,
      outcome: memory.outcome,
      insights: memory.insights,
      context: memory.context,
      createdAt: now,
      accessCount: 0,
      lastAccessedAt: now,
    };
  }

  /**
   * Get an episodic memory by ID.
   *
   * Looks up the knowledge_node with the given ID and `type = 'memory'`,
   * then unpacks the memory-specific fields from the `properties` JSON.
   */
  async getMemory(id: string): Promise<EpisodicMemory | undefined> {
    const row = await this.brain.get<NodeRow>(
      `SELECT * FROM knowledge_nodes WHERE brain_id = ? AND id = ? AND type = 'memory'`,
      [this.brain.brainId, id],
    );

    if (!row) return undefined;
    return this._rowToMemory(row);
  }

  /**
   * Delete the memory nodes that copy the filter's traces or scopes. The read is narrowed in SQL by the needles the
   * stored JSON must hold (`LIKE`, a superset: `_` and `%` in an id match more), and each row read is matched
   * exactly in code, so a malformed `properties` value is skipped rather than failing the delete.
   */
  async deleteMemories(filter: MemoryCopyFilter): Promise<number> {
    if (isEmptyCopyFilter(filter)) return 0;
    const brainId = this.brain.brainId;
    const ids = new Set<string>();
    for (const needle of copyNeedles(filter)) {
      const rows = await this.brain.all<{ id: string; properties: string }>(
        `SELECT id, properties FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory' AND properties LIKE ?`,
        [brainId, `%${needle}%`],
      );
      for (const row of rows) {
        let context: unknown;
        try {
          context = (JSON.parse(row.properties) as { _context?: unknown })._context;
        } catch {
          continue;
        }
        if (isMemoryCopyOf(context, filter)) ids.add(row.id);
      }
    }
    const list = [...ids];
    for (let offset = 0; offset < list.length; offset += 400) {
      const chunk = list.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(', ');
      await this.brain.run(
        `DELETE FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory' AND id IN (${placeholders})`,
        [brainId, ...chunk],
      );
    }
    return list.length;
  }

  /**
   * Query episodic memories with optional filters.
   *
   * Supports filtering by memory sub-type, participants, minimum importance,
   * time range, and result limit.
   */
  async queryMemories(options?: {
    types?: EpisodicMemory['type'][];
    participants?: string[];
    minImportance?: number;
    timeRange?: { from?: string; to?: string };
    limit?: number;
  }): Promise<EpisodicMemory[]> {
    const clauses: string[] = ['brain_id = ?', "type = 'memory'"];
    const params: unknown[] = [this.brain.brainId];

    // Filter by minimum importance (stored as confidence).
    if (options?.minImportance !== undefined) {
      clauses.push('confidence >= ?');
      params.push(options.minImportance);
    }

    // Filter by time range on created_at.
    if (options?.timeRange?.from) {
      clauses.push('created_at >= ?');
      params.push(new Date(options.timeRange.from).getTime());
    }
    if (options?.timeRange?.to) {
      clauses.push('created_at <= ?');
      params.push(new Date(options.timeRange.to).getTime());
    }

    const limit = options?.limit ?? 100;
    const sql = `SELECT * FROM knowledge_nodes WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await this.brain.all<NodeRow>(sql, params);
    let memories = rows.map((r) => this._rowToMemory(r));

    // Post-filter by memory sub-type (stored in properties JSON).
    if (options?.types && options.types.length > 0) {
      const typeSet = new Set(options.types);
      memories = memories.filter((m) => typeSet.has(m.type));
    }

    // Post-filter by participants (stored in properties JSON).
    if (options?.participants && options.participants.length > 0) {
      memories = memories.filter((m) =>
        options.participants!.some((p) => m.participants.includes(p)),
      );
    }

    return memories;
  }

  /**
   * Recall relevant memories via keyword search against summaries.
   *
   * Performs a case-insensitive substring match on the label (which contains
   * the summary text). Increments accessCount and updates lastAccessedAt for
   * each returned memory (Hebbian reinforcement).
   *
   * Full semantic (embedding-based) recall requires the Memory facade.
   */
  async recallMemories(query: string, topK?: number): Promise<EpisodicMemory[]> {
    const limit = topK ?? 10;
    const searchTerm = `%${query}%`;

    const rows = await this.brain.all<NodeRow>(
      `SELECT * FROM knowledge_nodes
       WHERE brain_id = ? AND type = 'memory' AND (label LIKE ? OR properties LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [this.brain.brainId, searchTerm, searchTerm, limit],
    );

    const memories = rows.map((r) => this._rowToMemory(r));

    // Update access count and last accessed for each recalled memory.
    const now = new Date().toISOString();
    for (const mem of memories) {
      const row = await this.brain.get<NodeRow>(
        'SELECT * FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
        [this.brain.brainId, mem.id],
      );

      if (row) {
        const fields = JSON.parse(row.properties) as MemoryNodeFields;
        fields._accessCount = (fields._accessCount ?? 0) + 1;
        fields._lastAccessedAt = now;

        await this.brain.run(
          'UPDATE knowledge_nodes SET properties = ? WHERE brain_id = ? AND id = ?',
          [JSON.stringify(fields), this.brain.brainId, mem.id],
        );

        mem.accessCount = fields._accessCount;
        mem.lastAccessedAt = now;
      }
    }

    return memories;
  }

  // =========================================================================
  // Graph Traversal
  // =========================================================================

  /**
   * Traverse the graph from a starting entity using BFS.
   *
   * Uses a recursive CTE (Common Table Expression) to walk the graph up to
   * `maxDepth` hops from the start node. Results are grouped by depth level.
   *
   * @param startEntityId - ID of the entity to start traversal from.
   * @param options       - Optional: maxDepth, relationTypes, direction, minWeight, maxNodes.
   */
  async traverse(
    startEntityId: EntityId,
    options?: TraversalOptions,
  ): Promise<TraversalResult> {
    const root = await this.getEntity(startEntityId);
    if (!root) {
      throw new Error(`Entity not found: ${startEntityId}`);
    }

    const maxDepth = options?.maxDepth ?? 3;
    const direction = options?.direction ?? 'both';
    const minWeight = options?.minWeight ?? 0;
    const maxNodes = options?.maxNodes ?? 1000;

    // Build the edge direction clause for the recursive step.
    // brain_id is filtered in the WHERE clause below; the join itself stays direction-only.
    let edgeJoin: string;
    if (direction === 'outgoing') {
      edgeJoin = 'knowledge_edges e ON e.source_id = t.entity_id AND e.brain_id = t.brain_id';
    } else if (direction === 'incoming') {
      edgeJoin = 'knowledge_edges e ON e.target_id = t.entity_id AND e.brain_id = t.brain_id';
    } else {
      edgeJoin = 'knowledge_edges e ON e.brain_id = t.brain_id AND (e.source_id = t.entity_id OR e.target_id = t.entity_id)';
    }

    // Build optional relation type filter.
    let typeFilter = '';
    const typeParams: string[] = [];
    if (options?.relationTypes && options.relationTypes.length > 0) {
      const placeholders = options.relationTypes.map(() => '?').join(', ');
      typeFilter = `AND e.type IN (${placeholders})`;
      typeParams.push(...options.relationTypes);
    }

    // Next entity ID expression depends on direction.
    let nextEntityExpr: string;
    if (direction === 'outgoing') {
      nextEntityExpr = 'e.target_id';
    } else if (direction === 'incoming') {
      nextEntityExpr = 'e.source_id';
    } else {
      nextEntityExpr = "CASE WHEN e.source_id = t.entity_id THEN e.target_id ELSE e.source_id END";
    }

    const sql = `
      WITH RECURSIVE traverse AS (
        SELECT
          CAST(? AS TEXT) AS brain_id,
          ? AS entity_id,
          0 AS depth,
          CAST(? AS TEXT) AS edge_id
        UNION ALL
        SELECT
          t.brain_id,
          ${nextEntityExpr},
          t.depth + 1,
          e.id
        FROM traverse t
        JOIN ${edgeJoin}
        WHERE t.depth < ?
          AND e.weight >= ?
          ${typeFilter}
          AND ${nextEntityExpr} != t.entity_id
      )
      SELECT DISTINCT entity_id, depth, edge_id
      FROM traverse
      LIMIT ?
    `;

    const params: unknown[] = [
      this.brain.brainId,
      startEntityId,
      '',  // placeholder edge_id for root
      maxDepth,
      minWeight,
      ...typeParams,
      maxNodes,
    ];

    const traversalRows = await this.brain.all<{
      entity_id: string;
      depth: number;
      edge_id: string;
    }>(sql, params);

    // Group by depth. Collect unique entity IDs per level.
    const levelMap = new Map<number, { entityIds: Set<string>; edgeIds: Set<string> }>();
    const visitedEntities = new Set<string>();

    for (const row of traversalRows) {
      if (visitedEntities.has(row.entity_id)) continue;
      visitedEntities.add(row.entity_id);

      if (!levelMap.has(row.depth)) {
        levelMap.set(row.depth, { entityIds: new Set(), edgeIds: new Set() });
      }
      const level = levelMap.get(row.depth)!;
      level.entityIds.add(row.entity_id);
      if (row.edge_id) {
        level.edgeIds.add(row.edge_id);
      }
    }

    // Resolve entities and relations for each level.
    const levels: TraversalResult['levels'] = [];
    let totalEntities = 0;
    let totalRelations = 0;

    for (const [depth, data] of [...levelMap.entries()].sort((a, b) => a[0] - b[0])) {
      const entities: KnowledgeEntity[] = [];
      for (const eid of data.entityIds) {
        const entity = await this.getEntity(eid);
        if (entity) entities.push(entity);
      }

      const relations: KnowledgeRelation[] = [];
      for (const rid of data.edgeIds) {
        const row = await this.brain.get<EdgeRow>(
          'SELECT * FROM knowledge_edges WHERE brain_id = ? AND id = ?',
          [this.brain.brainId, rid],
        );
        if (row) relations.push(this._rowToRelation(row));
      }

      levels.push({ depth, entities, relations });
      totalEntities += entities.length;
      totalRelations += relations.length;
    }

    return {
      root,
      levels,
      totalEntities,
      totalRelations,
    };
  }

  /**
   * Find the shortest path between two entities using a bidirectional BFS
   * implemented via a recursive CTE.
   *
   * Returns an ordered array of `{ entity, relation? }` steps from source to
   * target, or `null` if no path exists within `maxDepth` hops.
   */
  async findPath(
    sourceId: EntityId,
    targetId: EntityId,
    maxDepth?: number,
  ): Promise<Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> | null> {
    const depth = maxDepth ?? 10;

    // Use a recursive CTE that tracks the path as a comma-separated list of
    // "entityId:edgeId" pairs. Stops when targetId is reached.
    const sql = `
      WITH RECURSIVE path_search AS (
        SELECT
          CAST(? AS TEXT) AS brain_id,
          ? AS current_id,
          CAST(? AS TEXT) AS path_entities,
          CAST('' AS TEXT) AS path_edges,
          0 AS depth
        UNION ALL
        SELECT
          p.brain_id,
          CASE
            WHEN e.source_id = p.current_id THEN e.target_id
            ELSE e.source_id
          END,
          p.path_entities || ',' ||
            CASE WHEN e.source_id = p.current_id THEN e.target_id ELSE e.source_id END,
          CASE WHEN p.path_edges = '' THEN e.id ELSE p.path_edges || ',' || e.id END,
          p.depth + 1
        FROM path_search p
        JOIN knowledge_edges e
          ON e.brain_id = p.brain_id
         AND (e.source_id = p.current_id OR e.target_id = p.current_id)
        WHERE p.depth < ?
          AND p.path_entities NOT LIKE '%' ||
            CASE WHEN e.source_id = p.current_id THEN e.target_id ELSE e.source_id END || '%'
      )
      SELECT path_entities, path_edges, depth
      FROM path_search
      WHERE current_id = ?
      ORDER BY depth ASC
      LIMIT 1
    `;

    const row = await this.brain.get<{ path_entities: string; path_edges: string; depth: number }>(
      sql,
      [this.brain.brainId, sourceId, sourceId, depth, targetId],
    );

    if (!row) return null;

    const entityIds = row.path_entities.split(',').filter(Boolean);
    const edgeIds = row.path_edges.split(',').filter(Boolean);

    const result: Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> = [];

    for (let i = 0; i < entityIds.length; i++) {
      const entity = await this.getEntity(entityIds[i]);
      if (!entity) return null;

      let relation: KnowledgeRelation | undefined;
      if (i > 0 && edgeIds[i - 1]) {
        const edgeRow = await this.brain.get<EdgeRow>(
          'SELECT * FROM knowledge_edges WHERE brain_id = ? AND id = ?',
          [this.brain.brainId, edgeIds[i - 1]],
        );
        if (edgeRow) relation = this._rowToRelation(edgeRow);
      }

      result.push({ entity, relation });
    }

    return result;
  }

  /**
   * Get the neighbourhood of an entity — all entities and relations within
   * `depth` hops.
   *
   * @param entityId - Centre entity.
   * @param depth    - Maximum number of hops (default 1).
   */
  async getNeighborhood(
    entityId: EntityId,
    depth?: number,
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    const maxDepth = depth ?? 1;

    const sql = `
      WITH RECURSIVE neighborhood AS (
        SELECT CAST(? AS TEXT) AS brain_id, ? AS entity_id, 0 AS depth
        UNION ALL
        SELECT
          n.brain_id,
          CASE
            WHEN e.source_id = n.entity_id THEN e.target_id
            ELSE e.source_id
          END,
          n.depth + 1
        FROM neighborhood n
        JOIN knowledge_edges e
          ON e.brain_id = n.brain_id
         AND (e.source_id = n.entity_id OR e.target_id = n.entity_id)
        WHERE n.depth < ?
      )
      SELECT DISTINCT entity_id FROM neighborhood
    `;

    const rows = await this.brain.all<{ entity_id: string }>(sql, [this.brain.brainId, entityId, maxDepth]);

    const entityIds = new Set(rows.map((r) => r.entity_id));
    const entities: KnowledgeEntity[] = [];

    for (const eid of entityIds) {
      const entity = await this.getEntity(eid);
      if (entity) entities.push(entity);
    }

    // Collect all edges where both endpoints are in the neighbourhood.
    const allEdges = await this.brain.all<EdgeRow>(
      'SELECT * FROM knowledge_edges WHERE brain_id = ?',
      [this.brain.brainId],
    );

    const relations = allEdges
      .filter((e) => entityIds.has(e.source_id) && entityIds.has(e.target_id))
      .map((r) => this._rowToRelation(r));

    return { entities, relations };
  }

  // =========================================================================
  // Semantic Search
  // =========================================================================

  /**
   * Semantic search across entities and/or memories.
   *
   * Loads all embeddings from `knowledge_nodes`, computes cosine similarity
   * against the query embedding (if present in `options`), and returns the
   * top-K results above the minimum similarity threshold.
   *
   * NOTE: This implementation requires the caller to provide a query embedding
   * via a pre-processing step. If no nodes have embeddings, an empty array is
   * returned. For full text-to-embedding semantic search, use the Memory facade.
   */
  async semanticSearch(options: SemanticSearchOptions): Promise<SemanticSearchResult[]> {
    const scope = options.scope ?? 'all';
    const topK = options.topK ?? 10;
    const minSimilarity = options.minSimilarity ?? 0;

    // Build WHERE clause based on scope.
    const clauses: string[] = ['brain_id = ?', 'embedding IS NOT NULL'];

    if (scope === 'entities') {
      clauses.push("type != 'memory'");
    } else if (scope === 'memories') {
      clauses.push("type = 'memory'");
    }

    if (options.entityTypes && options.entityTypes.length > 0) {
      const placeholders = options.entityTypes.map(() => '?').join(', ');
      clauses.push(`type IN (${placeholders})`);
    }

    const sql = `SELECT * FROM knowledge_nodes WHERE ${clauses.join(' AND ')}`;
    const params: unknown[] = [this.brain.brainId];
    if (options.entityTypes && options.entityTypes.length > 0) {
      params.push(...options.entityTypes);
    }

    const rows = await this.brain.all<NodeRow>(sql, params);

    // We need a query embedding. For keyword-based fallback, we match by text.
    // Here we do keyword search since we don't have an embedding model.
    const queryLower = options.query.toLowerCase();
    const results: SemanticSearchResult[] = [];

    for (const row of rows) {
      // If the row has an embedding, we'd need a query embedding for cosine sim.
      // As a fallback, do keyword matching and assign a pseudo-similarity.
      const label = row.label.toLowerCase();
      const propsStr = row.properties.toLowerCase();

      let similarity = 0;
      if (label.includes(queryLower)) {
        similarity = 0.9; // Strong match on label.
      } else if (propsStr.includes(queryLower)) {
        similarity = 0.7; // Weaker match in properties.
      }

      if (similarity < minSimilarity) continue;

      const isMemory = row.type === 'memory';

      // Post-filter by ownerId if specified.
      if (options.ownerId) {
        const entity = this._rowToEntity(row);
        if (entity.ownerId !== options.ownerId) continue;
      }

      if (isMemory) {
        results.push({
          item: this._rowToMemory(row),
          type: 'memory',
          similarity,
        });
      } else {
        results.push({
          item: this._rowToEntity(row),
          type: 'entity',
          similarity,
        });
      }
    }

    // Also search nodes WITHOUT embeddings by keyword when no embedding vectors
    // are available (pure keyword fallback).
    if (results.length === 0) {
      const allNodesSql = `SELECT * FROM knowledge_nodes WHERE brain_id = ? AND ${
        scope === 'entities' ? "type != 'memory'" :
        scope === 'memories' ? "type = 'memory'" : '1=1'
      }`;
      const allRows = await this.brain.all<NodeRow>(allNodesSql, [this.brain.brainId]);

      for (const row of allRows) {
        const label = row.label.toLowerCase();
        const propsStr = row.properties.toLowerCase();

        let similarity = 0;
        if (label.includes(queryLower)) {
          similarity = 0.9;
        } else if (propsStr.includes(queryLower)) {
          similarity = 0.7;
        }

        if (similarity < minSimilarity) continue;

        if (options.ownerId) {
          const entity = this._rowToEntity(row);
          if (entity.ownerId !== options.ownerId) continue;
        }

        const isMemory = row.type === 'memory';
        results.push({
          item: isMemory ? this._rowToMemory(row) : this._rowToEntity(row),
          type: isMemory ? 'memory' : 'entity',
          similarity,
        });
      }
    }

    // Sort by similarity descending, take top-K.
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  // =========================================================================
  // Knowledge Extraction
  // =========================================================================

  /**
   * Extract entities and relations from text.
   *
   * This operation requires an LLM and is not supported at the store level.
   * Use the Memory facade for LLM-powered extraction.
   *
   * @throws {Error} Always — extraction requires an LLM.
   */
  async extractFromText(
    _text: string,
    _options?: { extractRelations?: boolean; entityTypes?: EntityType[] },
  ): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }> {
    throw new Error(
      'extractFromText requires an LLM — use the Memory facade for LLM-powered extraction',
    );
  }

  // =========================================================================
  // Maintenance
  // =========================================================================

  /**
   * Merge multiple entities into one primary entity.
   *
   * All relations (edges) pointing to or from the non-primary entities are
   * re-linked to the primary entity. The non-primary entities are then deleted.
   *
   * @param entityIds - All entity IDs involved in the merge.
   * @param primaryId - The ID that survives the merge.
   */
  async mergeEntities(
    entityIds: EntityId[],
    primaryId: EntityId,
  ): Promise<KnowledgeEntity> {
    const primary = await this.getEntity(primaryId);
    if (!primary) {
      throw new Error(`Primary entity not found: ${primaryId}`);
    }

    const othersIds = entityIds.filter((id) => id !== primaryId);
    const brainId = this.brain.brainId;

    await this.brain.transaction(async (trx) => {
      for (const otherId of othersIds) {
        // Re-link outgoing edges: source_id = otherId -> primaryId.
        await trx.run(
          'UPDATE knowledge_edges SET source_id = ? WHERE brain_id = ? AND source_id = ?',
          [primaryId, brainId, otherId],
        );

        // Re-link incoming edges: target_id = otherId -> primaryId.
        await trx.run(
          'UPDATE knowledge_edges SET target_id = ? WHERE brain_id = ? AND target_id = ?',
          [primaryId, brainId, otherId],
        );

        // Delete the non-primary entity node.
        await trx.run(
          'DELETE FROM knowledge_nodes WHERE brain_id = ? AND id = ?',
          [brainId, otherId],
        );
      }

      // Remove any self-referential edges that may have resulted from the merge.
      await trx.run(
        'DELETE FROM knowledge_edges WHERE brain_id = ? AND source_id = target_id',
        [brainId],
      );
    });

    // Return the surviving primary entity (re-fetch to reflect current state).
    return (await this.getEntity(primaryId))!;
  }

  /**
   * Decay the confidence of all memory-type nodes by a multiplicative factor.
   *
   * This simulates the Ebbinghaus forgetting curve — memories that are not
   * accessed (reinforced) gradually fade.
   *
   * @param decayFactor - Multiplicative factor in (0, 1). Default 0.95.
   * @returns The number of memory nodes whose confidence was reduced.
   */
  async decayMemories(decayFactor?: number): Promise<number> {
    const factor = decayFactor ?? 0.95;

    const result = await this.brain.run(
      `UPDATE knowledge_nodes
       SET confidence = confidence * ?
       WHERE brain_id = ? AND type = 'memory'`,
      [factor, this.brain.brainId],
    );

    return result.changes;
  }

  /**
   * Get aggregate statistics about the knowledge graph.
   *
   * Returns counts of entities, relations, memories, breakdowns by type,
   * average confidence, and oldest/newest entry timestamps.
   */
  async getStats(): Promise<KnowledgeGraphStats> {
    const brainId = this.brain.brainId;

    // Total non-memory entities.
    const entityCountRow = await this.brain.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE brain_id = ? AND type != 'memory'",
      [brainId],
    );
    const entityCount = entityCountRow?.cnt ?? 0;

    // Total relations.
    const relationCountRow = await this.brain.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM knowledge_edges WHERE brain_id = ?',
      [brainId],
    );
    const relationCount = relationCountRow?.cnt ?? 0;

    // Total memories.
    const memoryCountRow = await this.brain.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory'",
      [brainId],
    );
    const memoryCount = memoryCountRow?.cnt ?? 0;

    // Entity types breakdown (exclude memories).
    const entityTypeRows = await this.brain.all<{ type: string; cnt: number }>(
      "SELECT type, COUNT(*) AS cnt FROM knowledge_nodes WHERE brain_id = ? AND type != 'memory' GROUP BY type",
      [brainId],
    );
    const entitiesByType = {} as Record<EntityType, number>;
    for (const row of entityTypeRows) {
      entitiesByType[row.type as EntityType] = row.cnt;
    }

    // Relation types breakdown.
    const relTypeRows = await this.brain.all<{ type: string; cnt: number }>(
      'SELECT type, COUNT(*) AS cnt FROM knowledge_edges WHERE brain_id = ? GROUP BY type',
      [brainId],
    );
    const relationsByType = {} as Record<RelationType, number>;
    for (const row of relTypeRows) {
      relationsByType[row.type as RelationType] = row.cnt;
    }

    // Average confidence across all nodes.
    const avgConfRow = await this.brain.get<{ avg_conf: number | null }>(
      'SELECT AVG(confidence) AS avg_conf FROM knowledge_nodes WHERE brain_id = ?',
      [brainId],
    );
    const avgConf = avgConfRow?.avg_conf ?? 0;

    // Oldest and newest entries.
    const oldest = await this.brain.get<{ created_at: number }>(
      'SELECT created_at FROM knowledge_nodes WHERE brain_id = ? ORDER BY created_at ASC LIMIT 1',
      [brainId],
    );
    const newest = await this.brain.get<{ created_at: number }>(
      'SELECT created_at FROM knowledge_nodes WHERE brain_id = ? ORDER BY created_at DESC LIMIT 1',
      [brainId],
    );

    return {
      totalEntities: entityCount,
      totalRelations: relationCount,
      totalMemories: memoryCount,
      entitiesByType,
      relationsByType,
      avgConfidence: avgConf,
      oldestEntry: oldest ? new Date(oldest.created_at).toISOString() : '',
      newestEntry: newest ? new Date(newest.created_at).toISOString() : '',
    };
  }

  /**
   * Delete all rows from knowledge_nodes and knowledge_edges.
   * Wipes the knowledge graph completely.
   */
  async clear(): Promise<void> {
    const brainId = this.brain.brainId;
    await this.brain.transaction(async (trx) => {
      // Edges first (FK constraint on source_id / target_id -> knowledge_nodes).
      await trx.run('DELETE FROM knowledge_edges WHERE brain_id = ?', [brainId]);
      await trx.run('DELETE FROM knowledge_nodes WHERE brain_id = ?', [brainId]);
    });
  }

  // =========================================================================
  // Private: Row <-> Domain Object Converters
  // =========================================================================

  /**
   * Convert a raw `knowledge_nodes` row into a `KnowledgeEntity` domain object.
   * Unpacks extended fields from the `properties` JSON column.
   */
  private _rowToEntity(row: NodeRow): KnowledgeEntity {
    let extended: Partial<ExtendedNodeFields>;
    try {
      extended = JSON.parse(row.properties);
    } catch {
      extended = { _props: {} };
    }

    const source: KnowledgeSource = (() => {
      try {
        return JSON.parse(row.source) as KnowledgeSource;
      } catch {
        return { type: 'system' as const, timestamp: new Date(row.created_at).toISOString() };
      }
    })();

    return {
      id: row.id,
      type: row.type as EntityType,
      label: row.label,
      properties: extended._props ?? {},
      embedding: row.embedding ? this.brain.features.blobCodec.decode(row.embedding) : undefined,
      confidence: row.confidence,
      source,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: extended._updatedAt ?? new Date(row.created_at).toISOString(),
      ownerId: extended._ownerId,
      tags: extended._tags,
      metadata: extended._metadata,
    };
  }

  /**
   * Convert a raw `knowledge_edges` row into a `KnowledgeRelation` domain object.
   * Unpacks extended fields from the `metadata` JSON column.
   */
  private _rowToRelation(row: EdgeRow): KnowledgeRelation {
    let extended: Partial<ExtendedEdgeFields>;
    try {
      extended = JSON.parse(row.metadata);
    } catch {
      extended = {};
    }

    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as RelationType,
      label: extended._label ?? row.type,
      properties: extended._properties,
      weight: row.weight,
      bidirectional: row.bidirectional === 1,
      confidence: extended._confidence ?? 1,
      source: extended._source ?? { type: 'system', timestamp: new Date(row.created_at).toISOString() },
      createdAt: new Date(row.created_at).toISOString(),
      validFrom: extended._validFrom,
      validTo: extended._validTo,
    };
  }

  /**
   * Convert a raw `knowledge_nodes` row (with `type = 'memory'`) into an
   * `EpisodicMemory` domain object. Unpacks memory-specific fields from the
   * `properties` JSON column.
   */
  private _rowToMemory(row: NodeRow): EpisodicMemory {
    let fields: Partial<MemoryNodeFields>;
    try {
      fields = JSON.parse(row.properties);
    } catch {
      fields = {};
    }

    return {
      id: row.id,
      type: (fields._memoryType ?? 'interaction') as EpisodicMemory['type'],
      summary: fields._summary ?? row.label,
      description: fields._description,
      participants: fields._participants ?? [],
      valence: fields._valence,
      importance: row.confidence,
      entityIds: fields._entityIds ?? [],
      embedding: row.embedding ? this.brain.features.blobCodec.decode(row.embedding) : undefined,
      occurredAt: fields._occurredAt ?? new Date(row.created_at).toISOString(),
      durationMs: fields._durationMs,
      outcome: fields._outcome,
      insights: fields._insights,
      context: fields._context,
      createdAt: new Date(row.created_at).toISOString(),
      accessCount: fields._accessCount ?? 0,
      lastAccessedAt: fields._lastAccessedAt ?? new Date(row.created_at).toISOString(),
    };
  }
}
