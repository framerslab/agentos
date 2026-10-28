/**
 * @file IKnowledgeGraph.ts
 * @description Knowledge Graph interface for storing and querying
 * entities, relationships, episodic memories, and semantic knowledge.
 *
 * @module AgentOS/Knowledge
 * @version 1.0.0
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Unique identifier for entities and relations
 */
export type EntityId = string;
export type RelationId = string;

/**
 * Represents an entity (node) in the knowledge graph
 */
export interface KnowledgeEntity {
  /** Unique entity ID */
  id: EntityId;
  /** Entity type (person, concept, event, location, etc.) */
  type: EntityType;
  /** Human-readable label */
  label: string;
  /** Entity properties/attributes */
  properties: Record<string, unknown>;
  /** Vector embedding for similarity search */
  embedding?: number[];
  /** Confidence score (0-1) */
  confidence: number;
  /** Source of this knowledge */
  source: KnowledgeSource;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Associated GMI or user ID */
  ownerId?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Entity types in the knowledge graph
 */
export type EntityType =
  | 'person'
  | 'organization'
  | 'location'
  | 'event'
  | 'concept'
  | 'fact'
  | 'skill'
  | 'preference'
  | 'memory'
  | 'goal'
  | 'task'
  | 'document'
  | 'code'
  | 'custom';

/**
 * Source of knowledge
 */
export interface KnowledgeSource {
  /** Source type */
  type: 'user_input' | 'conversation' | 'rag_ingest' | 'web_search' | 'inference' | 'system';
  /** Source reference (conversation ID, document ID, URL, etc.) */
  reference?: string;
  /** Timestamp of extraction */
  timestamp: string;
  /** Extraction method */
  method?: string;
}

/**
 * Represents a relationship (edge) between entities
 */
export interface KnowledgeRelation {
  /** Unique relation ID */
  id: RelationId;
  /** Source entity ID */
  sourceId: EntityId;
  /** Target entity ID */
  targetId: EntityId;
  /** Relation type */
  type: RelationType;
  /** Relation label (e.g., "works_at", "knows", "caused_by") */
  label: string;
  /** Relation properties */
  properties?: Record<string, unknown>;
  /** Relation strength/weight (0-1) */
  weight: number;
  /** Is this relation bidirectional? */
  bidirectional: boolean;
  /** Confidence score */
  confidence: number;
  /** Source of this relation */
  source: KnowledgeSource;
  /** Creation timestamp */
  createdAt: string;
  /** Temporal validity (when was this relation true?) */
  validFrom?: string;
  validTo?: string;
}

/**
 * Relation types
 */
export type RelationType =
  | 'is_a'           // Taxonomy (cat IS_A animal)
  | 'part_of'        // Composition (wheel PART_OF car)
  | 'related_to'     // General association
  | 'causes'         // Causation
  | 'precedes'       // Temporal sequence
  | 'located_in'     // Spatial
  | 'created_by'     // Attribution
  | 'used_for'       // Purpose
  | 'has_property'   // Attribute
  | 'knows'          // Social
  | 'prefers'        // Preference
  | 'learned'        // Episodic
  | 'similar_to'     // Similarity
  | 'opposite_of'    // Contrast
  | 'custom';

// ============================================================================
// Episodic Memory Types
// ============================================================================

/**
 * Represents an episodic memory (specific experience/event)
 */
export interface EpisodicMemory {
  /** Unique memory ID */
  id: string;
  /** Memory type */
  type: 'conversation' | 'task' | 'discovery' | 'error' | 'success' | 'interaction';
  /** Summary of the episode */
  summary: string;
  /** Detailed description */
  description?: string;
  /** Participants (user IDs, GMI IDs) */
  participants: string[];
  /** Emotional valence (-1 to 1, negative to positive) */
  valence?: number;
  /** Importance score (0-1) */
  importance: number;
  /** Associated entity IDs */
  entityIds: EntityId[];
  /** Vector embedding */
  embedding?: number[];
  /** When did this happen? */
  occurredAt: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Outcome/result */
  outcome?: 'success' | 'failure' | 'partial' | 'unknown';
  /** Lessons learned */
  insights?: string[];
  /** Raw context data */
  context?: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: string;
  /** Access count (for decay/reinforcement) */
  accessCount: number;
  /** Last accessed timestamp */
  lastAccessedAt: string;
}

/**
 * Which episodic records {@link IKnowledgeGraph.deleteMemories} deletes: those whose `context.memoryTraceId` is one
 * of `traceIds`, and those whose `context.scope` and `context.scopeId` are one of `scopes`. A pair, not a bare scope
 * id: one id names several scopes (`user:42` and `organization:42`).
 */
export interface MemoryCopyFilter {
  traceIds?: readonly string[];
  scopes?: ReadonlyArray<{ scope: string; scopeId: string }>;
}

// ============================================================================
// Query Types
// ============================================================================

/**
 * Options for querying the knowledge graph
 */
export interface KnowledgeQueryOptions {
  /** Filter by entity types */
  entityTypes?: EntityType[];
  /** Filter by relation types */
  relationTypes?: RelationType[];
  /** Filter by owner */
  ownerId?: string;
  /** Filter by tags */
  tags?: string[];
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Include embeddings in results */
  includeEmbeddings?: boolean;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Time range filter */
  timeRange?: {
    from?: string;
    to?: string;
  };
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse */
  maxDepth?: number;
  /** Relation types to follow */
  relationTypes?: RelationType[];
  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** Minimum relation weight */
  minWeight?: number;
  /** Maximum nodes to visit */
  maxNodes?: number;
}

/**
 * Result of a graph traversal
 */
export interface TraversalResult {
  /** Starting entity */
  root: KnowledgeEntity;
  /** Discovered entities by depth level */
  levels: Array<{
    depth: number;
    entities: KnowledgeEntity[];
    relations: KnowledgeRelation[];
  }>;
  /** Total entities found */
  totalEntities: number;
  /** Total relations traversed */
  totalRelations: number;
}

/**
 * Semantic search options
 */
export interface SemanticSearchOptions {
  /** Query text */
  query: string;
  /** Search scope */
  scope?: 'entities' | 'memories' | 'all';
  /** Entity types to search */
  entityTypes?: EntityType[];
  /** Maximum results */
  topK?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Owner filter */
  ownerId?: string;
}

/**
 * Semantic search result
 */
export interface SemanticSearchResult {
  /** Matched entity or memory */
  item: KnowledgeEntity | EpisodicMemory;
  /** Item type */
  type: 'entity' | 'memory';
  /** Similarity score (0-1) */
  similarity: number;
  /** Related entities */
  relatedEntities?: KnowledgeEntity[];
}

// ============================================================================
// Knowledge Graph Interface
// ============================================================================

/**
 * Statistics about the knowledge graph
 */
export interface KnowledgeGraphStats {
  totalEntities: number;
  totalRelations: number;
  totalMemories: number;
  entitiesByType: Record<EntityType, number>;
  relationsByType: Record<RelationType, number>;
  avgConfidence: number;
  oldestEntry: string;
  newestEntry: string;
}

/**
 * Interface for the Knowledge Graph system
 */
export interface IKnowledgeGraph {
  // ============ Initialization ============
  
  /**
   * Initialize the knowledge graph
   */
  initialize(): Promise<void>;

  // ============ Entity Operations ============
  
  /**
   * Add or update an entity
   */
  upsertEntity(entity: Omit<KnowledgeEntity, 'id' | 'createdAt' | 'updatedAt'> & { id?: EntityId }): Promise<KnowledgeEntity>;

  /**
   * Get entity by ID
   */
  getEntity(id: EntityId): Promise<KnowledgeEntity | undefined>;

  /**
   * Query entities
   */
  queryEntities(options?: KnowledgeQueryOptions): Promise<KnowledgeEntity[]>;

  /**
   * Delete an entity and its relations
   */
  deleteEntity(id: EntityId): Promise<boolean>;

  // ============ Relation Operations ============
  
  /**
   * Add or update a relation
   */
  upsertRelation(relation: Omit<KnowledgeRelation, 'id' | 'createdAt'> & { id?: RelationId }): Promise<KnowledgeRelation>;

  /**
   * Get relations for an entity
   */
  getRelations(entityId: EntityId, options?: { direction?: 'outgoing' | 'incoming' | 'both'; types?: RelationType[] }): Promise<KnowledgeRelation[]>;

  /**
   * Delete a relation
   */
  deleteRelation(id: RelationId): Promise<boolean>;

  // ============ Episodic Memory Operations ============
  
  /**
   * Record an episodic memory
   */
  recordMemory(memory: Omit<EpisodicMemory, 'id' | 'createdAt' | 'accessCount' | 'lastAccessedAt'>): Promise<EpisodicMemory>;

  /**
   * Get memory by ID
   */
  getMemory(id: string): Promise<EpisodicMemory | undefined>;

  /**
   * Query episodic memories
   */
  queryMemories(options?: {
    types?: EpisodicMemory['type'][];
    participants?: string[];
    minImportance?: number;
    timeRange?: { from?: string; to?: string };
    limit?: number;
  }): Promise<EpisodicMemory[]>;

  /**
   * Recall relevant memories (updates access count)
   */
  recallMemories(query: string, topK?: number): Promise<EpisodicMemory[]>;

  /**
   * Delete the episodic records that copy memory traces ({@link MemoryCopyFilter}). `MemoryStore.store` records each
   * trace here with its full text, so a deleted trace takes its record with it. Optional: a graph without it keeps
   * its records, and `CognitiveMemoryManager.deleteScope` reports it as not reached.
   *
   * @returns The number of records deleted.
   */
  deleteMemories?(filter: MemoryCopyFilter): Promise<number>;

  // ============ Graph Traversal ============
  
  /**
   * Traverse the graph from a starting entity
   */
  traverse(startEntityId: EntityId, options?: TraversalOptions): Promise<TraversalResult>;

  /**
   * Find shortest path between two entities
   */
  findPath(sourceId: EntityId, targetId: EntityId, maxDepth?: number): Promise<Array<{ entity: KnowledgeEntity; relation?: KnowledgeRelation }> | null>;

  /**
   * Get neighborhood of an entity
   */
  getNeighborhood(entityId: EntityId, depth?: number): Promise<{ entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }>;

  // ============ Semantic Search ============
  
  /**
   * Semantic search across entities and memories
   */
  semanticSearch(options: SemanticSearchOptions): Promise<SemanticSearchResult[]>;

  // ============ Knowledge Extraction ============
  
  /**
   * Extract entities and relations from text
   */
  extractFromText(text: string, options?: { extractRelations?: boolean; entityTypes?: EntityType[] }): Promise<{
    entities: KnowledgeEntity[];
    relations: KnowledgeRelation[];
  }>;

  // ============ Maintenance ============
  
  /**
   * Merge duplicate entities
   */
  mergeEntities(entityIds: EntityId[], primaryId: EntityId): Promise<KnowledgeEntity>;

  /**
   * Decay old memories (reduce importance over time)
   */
  decayMemories(decayFactor?: number): Promise<number>;

  /**
   * Get knowledge graph statistics
   */
  getStats(): Promise<KnowledgeGraphStats>;

  /**
   * Clear all knowledge
   */
  clear(): Promise<void>;
}



