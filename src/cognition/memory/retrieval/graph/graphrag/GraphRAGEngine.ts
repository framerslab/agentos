/**
 * @file GraphRAGEngine.ts
 * @description TypeScript-native GraphRAG engine for AgentOS.
 * Implements entity extraction, graph construction, Louvain community detection,
 * community summarization, and global/local search -- all without Python.
 *
 * Uses:
 * - graphology for graph data structure
 * - graphology-communities-louvain for community detection
 * - IVectorStore (hnswlib or sql) for embedding search
 * - IEmbeddingManager for embeddings
 * - sql-storage-adapter for persistence
 *
 * @module AgentOS/RAG/GraphRAG
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';

// Lazy-loaded graphology (optional peer dependency)
type GraphInstance = import('graphology').default;
type GraphConstructor = new (opts?: Record<string, unknown>) => GraphInstance;
let _GraphCtor: GraphConstructor | undefined;
 
let _louvain: ((graph: any, options?: any) => Record<string, number>) | undefined;

async function resolveGraph(): Promise<GraphConstructor> {
  if (_GraphCtor) return _GraphCtor;
  try {
    const mod = await import('graphology');
    // graphology's CJS bundle exposes the Graph class as a named
    // export (`Graph`) and leaves `default` undefined; the ESM bundle
    // does ship a default. Fall through both shapes before failing.
    const candidate =
      (mod as any).default ??
      (mod as any).Graph ??
      mod;
    if (typeof candidate !== 'function') {
      throw new Error('graphology module did not expose a constructor');
    }
    _GraphCtor = candidate as GraphConstructor;
    return _GraphCtor;
  } catch (e) {
    throw new Error(
      'graphology is required for GraphRAGEngine but was not found or unusable. ' +
        'Install it: npm install graphology graphology-types' +
        (e instanceof Error ? ` (${e.message})` : ''),
    );
  }
}

async function resolveLouvain(): Promise<NonNullable<typeof _louvain>> {
  if (_louvain) return _louvain;
  try {
    const mod = await import('graphology-communities-louvain');
    _louvain = (mod.default ?? mod) as unknown as NonNullable<typeof _louvain>;
    return _louvain;
  } catch {
    throw new Error(
      'graphology-communities-louvain is required for community detection but was not found. ' +
        'Install it: npm install graphology-communities-louvain',
    );
  }
}

import type {
  IGraphRAGEngine,
  GraphRAGConfig,
  GraphEntity,
  GraphRelationship,
  GraphCommunity,
  GraphRAGSearchOptions,
  GlobalSearchResult,
  LocalSearchResult,
  ExtractionResult,
} from './IGraphRAG.js';
import type { IVectorStore, VectorDocument, MetadataValue } from '../../../../../core/vector-store/IVectorStore.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import { GMIError, GMIErrorCode } from '../../../../../core/utils/errors.js';

// =============================================================================
// Internal Types
// =============================================================================

interface LLMProvider {
  generateText(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

interface PersistenceAdapter {
  exec(script: string): Promise<void>;
  run(statement: string, parameters?: any[]): Promise<{ changes: number }>;
  all<T = unknown>(statement: string, parameters?: any[]): Promise<T[]>;
  get<T = unknown>(statement: string, parameters?: any[]): Promise<T | null>;
}

type DocumentEntityContribution = {
  entityId: string;
  name: string;
  type: string;
  description: string;
  frequency: number;
};

type DocumentRelationshipContribution = {
  relationshipId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  description: string;
  weight: number;
};

// =============================================================================
// GraphRAGEngine
// =============================================================================

export class GraphRAGEngine implements IGraphRAGEngine {
  private config!: GraphRAGConfig;
  private isInitialized: boolean = false;

  // Core data stores
  private entities: Map<string, GraphEntity> = new Map();
  private relationships: Map<string, GraphRelationship> = new Map();
  private communities: Map<string, GraphCommunity> = new Map();
  private ingestedDocumentIds: Set<string> = new Set();
  private ingestedDocumentHashes: Map<string, string> = new Map();
  private documentEntityContributions: Map<string, Map<string, DocumentEntityContribution>> = new Map();
  private documentRelationshipContributions: Map<string, Map<string, DocumentRelationshipContribution>> = new Map();

  // Graph structure (graphology — lazy-loaded)
  private graph!: GraphInstance;

  // External dependencies (injected)
  private vectorStore?: IVectorStore;
  private embeddingManager?: IEmbeddingManager;
  private llmProvider?: LLMProvider;
  private persistenceAdapter?: PersistenceAdapter;

  private tablePrefix: string = 'graphrag_';

  constructor(deps?: {
    vectorStore?: IVectorStore;
    embeddingManager?: IEmbeddingManager;
    llmProvider?: LLMProvider;
    persistenceAdapter?: PersistenceAdapter;
  }) {
    if (deps) {
      this.vectorStore = deps.vectorStore;
      this.embeddingManager = deps.embeddingManager;
      this.llmProvider = deps.llmProvider;
      this.persistenceAdapter = deps.persistenceAdapter;
    }
  }

  private async resolveEmbeddingDimension(): Promise<number> {
    const configured = this.config.embeddingDimension;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return configured;
    }

    if (!this.embeddingManager) {
      return 1536;
    }

    try {
      const resp = await this.embeddingManager.generateEmbeddings({
        texts: 'dimension probe',
        modelId: this.config.embeddingModelId,
      });
      const embedding = resp?.embeddings?.[0];
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding.length;
      }
    } catch {
      // Fall back to a sensible default.
    }

    return 1536;
  }

  private async hashDocumentContent(content: string): Promise<string> {
    const text = content ?? '';
    const bytes = new TextEncoder().encode(text);

    // Prefer WebCrypto for edge/browser compatibility.
    const subtle = (globalThis as any)?.crypto?.subtle as any;
    if (subtle?.digest) {
      const digest = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    // Fallback: Node.js crypto (dynamic import so bundlers can tree-shake it for browsers).
    try {
      const cryptoMod = await import('crypto');
      return cryptoMod.createHash('sha256').update(text).digest('hex');
    } catch {
      // Last-resort: non-cryptographic hash (collision-resistant enough for "skip exact duplicates").
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }
  }

  async initialize(config: GraphRAGConfig): Promise<void> {
    if (this.isInitialized) {
      console.warn(`[GraphRAGEngine:${config.engineId}] Re-initializing.`);
      await this.clear();
    }

    this.config = {
      entityTypes: ['person', 'organization', 'location', 'event', 'concept', 'technology'],
      maxCommunityLevels: 3,
      minCommunitySize: 2,
      communityResolution: 1.0,
      generateEntityEmbeddings: true,
      entityCollectionName: 'graphrag_entities',
      communityCollectionName: 'graphrag_communities',
      tablePrefix: 'graphrag_',
      ...config,
    };

    this.tablePrefix = this.config.tablePrefix ?? 'graphrag_';
    const GraphCtor = await resolveGraph();
    this.graph = new GraphCtor({ multi: false, type: 'undirected' });

    // Initialize persistence schema if adapter available
    if (this.persistenceAdapter) {
      await this.createPersistenceSchema();
      await this.loadFromPersistence();
    }

    // Initialize vector store collections
    if (this.vectorStore && (this.embeddingManager || typeof this.config.embeddingDimension === 'number')) {
      const dim = await this.resolveEmbeddingDimension();
      this.config.embeddingDimension = dim;
      try {
        if (this.vectorStore.createCollection) {
          const entityColExists = await this.vectorStore.collectionExists?.(this.config.entityCollectionName!);
          if (!entityColExists) {
            await this.vectorStore.createCollection(this.config.entityCollectionName!, dim);
          }
          const communityColExists = await this.vectorStore.collectionExists?.(this.config.communityCollectionName!);
          if (!communityColExists) {
            await this.vectorStore.createCollection(this.config.communityCollectionName!, dim);
          }
        }
      } catch {
        // Collections may already exist
      }
    }

    this.isInitialized = true;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        'GraphRAGEngine is not initialized. Call initialize() first.',
        GMIErrorCode.NOT_INITIALIZED,
        undefined,
        'GraphRAGEngine',
      );
    }
  }

  // ===========================================================================
  // Document Ingestion Pipeline
  // ===========================================================================

  async ingestDocuments(
    documents: Array<{ id: string; content: string; metadata?: Record<string, MetadataValue> }>,
  ): Promise<{
    entitiesExtracted: number;
    relationshipsExtracted: number;
    communitiesDetected: number;
    documentsProcessed: number;
  }> {
    this.ensureInitialized();

    let totalEntities = 0;
    let totalRelationships = 0;
    const touchedEntityIds = new Set<string>();
    const touchedRelationshipIds = new Set<string>();
    const entitiesNeedingEmbedding = new Set<string>();

    // Step 1: Extract entities and relationships from each document
    for (const doc of documents) {
      const contentHash = await this.hashDocumentContent(doc.content);
      const wasIngested = this.ingestedDocumentIds.has(doc.id);
      const previousHash = this.ingestedDocumentHashes.get(doc.id);

      // Skip exact duplicates (same docId + same content hash).
      if (wasIngested && previousHash && previousHash === contentHash) {
        continue;
      }

      // If this documentId was ingested before but changed, remove prior contributions first.
      if (wasIngested) {
        try {
          const removed = await this.removeDocumentContributions(doc.id);
          for (const id of removed.touchedEntityIds) touchedEntityIds.add(id);
          for (const id of removed.touchedRelationshipIds) touchedRelationshipIds.add(id);
          for (const id of removed.entitiesNeedingEmbedding) entitiesNeedingEmbedding.add(id);
        } catch (error) {
          // Safety: do not double-count if we cannot reliably subtract the previous doc's contributions.
          console.warn(
            `[GraphRAGEngine] Skipping update for document '${doc.id}' because previous contribution records are missing. ` +
              `Rebuild the GraphRAG index to enable updates. Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }

      const extraction = await this.extractEntitiesAndRelationships(doc.id, doc.content);
      totalEntities += extraction.entities.length;
      totalRelationships += extraction.relationships.length;

      // Merge into graph, tracking canonical IDs so relationships always point at the
      // deduplicated entity IDs (otherwise edges can get dropped on merge).
      const extractedToCanonicalEntityId = new Map<string, string>();
      const docEntityContribs = new Map<string, DocumentEntityContribution>();

      for (const entity of extraction.entities) {
        const canonical = this.mergeEntity(entity);
        extractedToCanonicalEntityId.set(entity.id, canonical.id);
        touchedEntityIds.add(canonical.id);
        entitiesNeedingEmbedding.add(canonical.id);

        const frequency = Number.isFinite(entity.frequency) ? entity.frequency : 1;
        const prev = docEntityContribs.get(canonical.id);
        if (prev) {
          prev.frequency += frequency;
          if (!prev.description && entity.description) prev.description = entity.description;
          if (prev.type === 'concept' && entity.type && entity.type !== 'concept') {
            prev.type = entity.type;
          }
        } else {
          docEntityContribs.set(canonical.id, {
            entityId: canonical.id,
            name: canonical.name,
            type: entity.type || canonical.type,
            description: entity.description || '',
            frequency,
          });
        }
      }
      for (const rel of extraction.relationships) {
        const sourceEntityId = extractedToCanonicalEntityId.get(rel.sourceEntityId) ?? rel.sourceEntityId;
        const targetEntityId = extractedToCanonicalEntityId.get(rel.targetEntityId) ?? rel.targetEntityId;
        if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) continue;

        const canonicalRel = this.mergeRelationship({
          ...rel,
          sourceEntityId,
          targetEntityId,
        });
        if (!canonicalRel) continue;

        touchedRelationshipIds.add(canonicalRel.id);

        const docRelContribs =
          this.documentRelationshipContributions.get(doc.id) ?? new Map<string, DocumentRelationshipContribution>();
        const weight = Number.isFinite(rel.weight) ? rel.weight : 1.0;
        const prev = docRelContribs.get(canonicalRel.id);
        if (prev) {
          prev.weight += weight;
          if (!prev.description && rel.description) prev.description = rel.description;
        } else {
          docRelContribs.set(canonicalRel.id, {
            relationshipId: canonicalRel.id,
            sourceEntityId: canonicalRel.sourceEntityId,
            targetEntityId: canonicalRel.targetEntityId,
            type: canonicalRel.type,
            description: rel.description || '',
            weight,
          });
        }
        this.documentRelationshipContributions.set(doc.id, docRelContribs);
      }

      this.documentEntityContributions.set(doc.id, docEntityContribs);
      if (!this.documentRelationshipContributions.has(doc.id)) {
        this.documentRelationshipContributions.set(doc.id, new Map());
      }

      this.ingestedDocumentIds.add(doc.id);
      this.ingestedDocumentHashes.set(doc.id, contentHash);
    }

    for (const entityId of touchedEntityIds) {
      this.recomputeEntityAggregates(entityId);
    }
    for (const relId of touchedRelationshipIds) {
      this.recomputeRelationshipAggregates(relId);
    }

    // Step 2: Generate entity embeddings
    if (this.embeddingManager && this.vectorStore && this.config.generateEntityEmbeddings) {
      await this.generateEntityEmbeddings(entitiesNeedingEmbedding);
    }

    // Step 3: Detect communities using Louvain
    const communitiesDetected = await this.detectCommunities();

    // Step 4: Generate community summaries
    if (this.llmProvider) {
      await this.generateCommunitySummaries();
    }

    // Step 5: Persist to database
    if (this.persistenceAdapter) {
      await this.persistAll();
    }

    return {
      entitiesExtracted: totalEntities,
      relationshipsExtracted: totalRelationships,
      communitiesDetected,
      documentsProcessed: documents.length,
    };
  }

  async removeDocuments(documentIds: string[]): Promise<{
    documentsRemoved: number;
    communitiesDetected: number;
  }> {
    this.ensureInitialized();

    const touchedEntityIds = new Set<string>();
    const touchedRelationshipIds = new Set<string>();
    const entitiesNeedingEmbedding = new Set<string>();
    let documentsRemoved = 0;

    for (const rawId of documentIds) {
      const documentId = String(rawId || '').trim();
      if (!documentId) continue;
      if (!this.ingestedDocumentIds.has(documentId)) continue;

      try {
        const removed = await this.removeDocumentContributions(documentId);
        documentsRemoved += 1;
        for (const id of removed.touchedEntityIds) touchedEntityIds.add(id);
        for (const id of removed.touchedRelationshipIds) touchedRelationshipIds.add(id);
        for (const id of removed.entitiesNeedingEmbedding) entitiesNeedingEmbedding.add(id);
        this.ingestedDocumentIds.delete(documentId);
        this.ingestedDocumentHashes.delete(documentId);
      } catch (error) {
        console.warn(
          `[GraphRAGEngine] Failed to remove document '${documentId}' contributions: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (documentsRemoved === 0) {
      return { documentsRemoved: 0, communitiesDetected: this.communities.size };
    }

    for (const entityId of touchedEntityIds) {
      this.recomputeEntityAggregates(entityId);
    }
    for (const relId of touchedRelationshipIds) {
      this.recomputeRelationshipAggregates(relId);
    }

    if (this.embeddingManager && this.vectorStore && this.config.generateEntityEmbeddings) {
      await this.generateEntityEmbeddings(entitiesNeedingEmbedding);
    }

    const communitiesDetected = await this.detectCommunities();
    if (this.llmProvider) {
      await this.generateCommunitySummaries();
    }
    if (this.persistenceAdapter) {
      await this.persistAll();
    }

    return { documentsRemoved, communitiesDetected };
  }

  // ===========================================================================
  // Entity & Relationship Extraction
  // ===========================================================================

  private async extractEntitiesAndRelationships(
    documentId: string,
    content: string,
  ): Promise<ExtractionResult> {
    // If LLM provider available, use LLM-driven extraction
    if (this.llmProvider) {
      return this.llmExtract(documentId, content);
    }

    // Fallback: pattern-based extraction
    return this.patternExtract(documentId, content);
  }

  private async llmExtract(documentId: string, content: string): Promise<ExtractionResult> {
    const entityTypesStr = (this.config.entityTypes ?? []).join(', ');
    const prompt = `Extract all entities and relationships from the following text.

Entity types to look for: ${entityTypesStr}

For each entity, provide:
- name: the entity name
- type: one of [${entityTypesStr}]
- description: brief description of the entity in context

For each relationship, provide:
- source: source entity name
- target: target entity name
- type: relationship type (e.g., "works_for", "located_in", "related_to", "uses", "creates")
- description: brief description of the relationship

Respond in JSON format:
{
  "entities": [{"name": "...", "type": "...", "description": "..."}],
  "relationships": [{"source": "...", "target": "...", "type": "...", "description": "..."}]
}

Text:
${content.slice(0, 8000)}`;

    try {
      const response = await this.llmProvider!.generateText(prompt, {
        maxTokens: 2000,
        temperature: 0,
      });

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.patternExtract(documentId, content);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const now = new Date().toISOString();

      const entities: GraphEntity[] = (parsed.entities ?? []).map((e: any) => ({
        id: `entity-${uuidv4().slice(0, 8)}`,
        name: String(e.name || '').trim(),
        type: String(e.type || 'concept').toLowerCase(),
        description: String(e.description || ''),
        properties: {},
        sourceDocumentIds: [documentId],
        frequency: 1,
        createdAt: now,
        updatedAt: now,
      }));

      // Build name→id map for relationship linking
      const nameToId = new Map<string, string>();
      for (const entity of entities) {
        nameToId.set(entity.name.toLowerCase(), entity.id);
      }

      const relationships: GraphRelationship[] = (parsed.relationships ?? [])
        .map((r: any) => {
          const sourceId = nameToId.get(String(r.source || '').toLowerCase().trim());
          const targetId = nameToId.get(String(r.target || '').toLowerCase().trim());
          if (!sourceId || !targetId || sourceId === targetId) return null;

          return {
            id: `rel-${uuidv4().slice(0, 8)}`,
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            type: String(r.type || 'related_to'),
            description: String(r.description || ''),
            weight: 1.0,
            properties: {},
            sourceDocumentIds: [documentId],
            createdAt: now,
          } as GraphRelationship;
        })
        .filter(Boolean) as GraphRelationship[];

      return { entities, relationships, sourceDocumentId: documentId };
    } catch (_error) {
      // Fallback to pattern extraction on any LLM error
      return this.patternExtract(documentId, content);
    }
  }

  private patternExtract(documentId: string, content: string): ExtractionResult {
    const now = new Date().toISOString();
    const entities: GraphEntity[] = [];
    const relationships: GraphRelationship[] = [];
    const seenNames = new Set<string>();

    // Extract capitalized multi-word entities (proper nouns)
    // Pattern: Capital letter + lowercase letters, optionally followed by more capitalized words
    const properNounPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
    let match;
    while ((match = properNounPattern.exec(content)) !== null) {
      const name = match[1].trim();
      if (name.length < 3 || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());

      entities.push({
        id: `entity-${uuidv4().slice(0, 8)}`,
        name,
        type: 'concept',
        description: this.extractSentenceContext(content, name),
        properties: {},
        sourceDocumentIds: [documentId],
        frequency: this.countOccurrences(content, name),
        createdAt: now,
        updatedAt: now,
      });
    }

    // Create relationships between entities that appear in the same sentence
    const sentences = content.split(/[.!?]+/);
    for (const sentence of sentences) {
      const sentenceEntities = entities.filter(e =>
        sentence.toLowerCase().includes(e.name.toLowerCase()),
      );
      for (let i = 0; i < sentenceEntities.length; i++) {
        for (let j = i + 1; j < sentenceEntities.length; j++) {
          relationships.push({
            id: `rel-${uuidv4().slice(0, 8)}`,
            sourceEntityId: sentenceEntities[i].id,
            targetEntityId: sentenceEntities[j].id,
            type: 'related_to',
            description: sentence.trim().slice(0, 200),
            weight: 1.0,
            properties: {},
            sourceDocumentIds: [documentId],
            createdAt: now,
          });
        }
      }
    }

    return { entities, relationships, sourceDocumentId: documentId };
  }

  private extractSentenceContext(text: string, term: string): string {
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx === -1) return '';
    const start = Math.max(0, text.lastIndexOf('.', idx) + 1);
    const end = text.indexOf('.', idx + term.length);
    return text.slice(start, end > 0 ? end + 1 : start + 300).trim();
  }

  private countOccurrences(text: string, term: string): number {
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return (text.match(regex) || []).length;
  }

  // ===========================================================================
  // Entity & Relationship Merging (deduplication)
  // ===========================================================================

  private mergeEntity(entity: GraphEntity): GraphEntity {
    // Check if entity with same name already exists (case-insensitive)
    const normalizedName = entity.name.toLowerCase().trim();
    let existing: GraphEntity | undefined;

    for (const [, e] of this.entities) {
      if (e.name.toLowerCase().trim() === normalizedName) {
        existing = e;
        break;
      }
    }

    if (existing) {
      // Merge: update frequency, add source docs, merge descriptions
      existing.frequency += entity.frequency;
      existing.updatedAt = new Date().toISOString();
      for (const docId of entity.sourceDocumentIds) {
        if (!existing.sourceDocumentIds.includes(docId)) {
          existing.sourceDocumentIds.push(docId);
        }
      }
      if (existing.type === 'concept' && entity.type && entity.type !== 'concept') {
        existing.type = entity.type;
      }

      // Update graph node
      if (!this.graph.hasNode(existing.id)) {
        this.graph.addNode(existing.id, { name: existing.name, type: existing.type });
      }
      return existing;
    } else {
      // Add new entity
      this.entities.set(entity.id, entity);
      this.graph.addNode(entity.id, { name: entity.name, type: entity.type });
      return entity;
    }
  }

  private mergeRelationship(rel: GraphRelationship): GraphRelationship | null {
    // Ensure both entities exist in graph
    if (!this.graph.hasNode(rel.sourceEntityId) || !this.graph.hasNode(rel.targetEntityId)) {
      return null;
    }

    // Check for existing edge between same entities
    const edgeKey = `${rel.sourceEntityId}-${rel.targetEntityId}`;
    const reverseKey = `${rel.targetEntityId}-${rel.sourceEntityId}`;

    let existing: GraphRelationship | undefined;
    for (const [, r] of this.relationships) {
      const rKey = `${r.sourceEntityId}-${r.targetEntityId}`;
      const rRev = `${r.targetEntityId}-${r.sourceEntityId}`;
      if (rKey === edgeKey || rKey === reverseKey || rRev === edgeKey) {
        existing = r;
        break;
      }
    }

    if (existing) {
      // Increase weight for repeated relationships
      existing.weight += rel.weight;
      for (const docId of rel.sourceDocumentIds) {
        if (!existing.sourceDocumentIds.includes(docId)) {
          existing.sourceDocumentIds.push(docId);
        }
      }
      try {
        (this.graph as any).setEdgeAttribute?.(existing.id, 'weight', existing.weight);
      } catch {
        // Best-effort: edge weight updates improve community detection but are not required.
      }
      return existing;
    } else {
      this.relationships.set(rel.id, rel);
      try {
        (this.graph as any).addEdgeWithKey?.(
          rel.id,
          rel.sourceEntityId,
          rel.targetEntityId,
          { id: rel.id, type: rel.type, weight: rel.weight },
        );
        if (!(this.graph as any).addEdgeWithKey) {
          this.graph.addEdge(rel.sourceEntityId, rel.targetEntityId, {
            id: rel.id,
            type: rel.type,
            weight: rel.weight,
          });
        }
      } catch {
        // Edge may already exist in undirected graph
      }
      return rel;
    }
  }

  // ===========================================================================
  // Entity Embeddings
  // ===========================================================================

  private async generateEntityEmbeddings(forceEntityIds?: Set<string>): Promise<void> {
    if (!this.embeddingManager || !this.vectorStore) return;

    const entitiesToEmbed: GraphEntity[] = [];
    for (const entity of this.entities.values()) {
      if (!entity.embedding || (forceEntityIds && forceEntityIds.has(entity.id))) {
        entity.embedding = undefined;
        entitiesToEmbed.push(entity);
      }
    }

    if (entitiesToEmbed.length === 0) return;

    // Generate embeddings in batches
    const batchSize = 32;
    for (let i = 0; i < entitiesToEmbed.length; i += batchSize) {
      const batch = entitiesToEmbed.slice(i, i + batchSize);
      const texts = batch.map(e => `${e.name}: ${e.description}`);

      try {
        const result = await this.embeddingManager.generateEmbeddings({
          texts,
          modelId: this.config.embeddingModelId,
        });

        // Store embeddings on entities and in vector store
        const vectorDocs: VectorDocument[] = [];
        for (let j = 0; j < batch.length; j++) {
          const embedding = result.embeddings[j];
          if (embedding) {
            batch[j].embedding = embedding;
            vectorDocs.push({
              id: batch[j].id,
              embedding,
              textContent: `${batch[j].name}: ${batch[j].description}`,
              metadata: {
                entityName: batch[j].name,
                entityType: batch[j].type,
                frequency: batch[j].frequency,
              },
            });
          }
        }

        if (vectorDocs.length > 0) {
          await this.vectorStore.upsert(this.config.entityCollectionName!, vectorDocs);
        }
      } catch (error) {
        console.warn('[GraphRAGEngine] Failed to generate entity embeddings:', error);
      }
    }
  }

  // ===========================================================================
  // Community Detection (Louvain via graphology)
  // ===========================================================================

  private async detectCommunities(): Promise<number> {
    if (this.graph.order < 2) return 0;

    this.communities.clear();

    // Run Louvain community detection (lazy-loaded)
    const louvainFn = await resolveLouvain();
    const communityAssignments = louvainFn(this.graph, {
      resolution: this.config.communityResolution ?? 1.0,
      getEdgeWeight: 'weight',
    });

    // Group entities by community
    const communityGroups = new Map<number, string[]>();
    for (const [nodeId, communityId] of Object.entries(communityAssignments)) {
      const cId = communityId as number;
      if (!communityGroups.has(cId)) {
        communityGroups.set(cId, []);
      }
      communityGroups.get(cId)!.push(nodeId);
    }

    const now = new Date().toISOString();

    // Create community objects (Level 0 = most granular)
    for (const [communityIdx, entityIds] of communityGroups) {
      if (entityIds.length < (this.config.minCommunitySize ?? 2)) continue;

      // Find internal relationships
      const internalRelIds: string[] = [];
      for (const [relId, rel] of this.relationships) {
        if (entityIds.includes(rel.sourceEntityId) && entityIds.includes(rel.targetEntityId)) {
          internalRelIds.push(relId);
        }
      }

      // Compute importance based on entity frequency and relationship count
      let importance = 0;
      for (const eId of entityIds) {
        const entity = this.entities.get(eId);
        if (entity) importance += entity.frequency;
      }
      importance += internalRelIds.length;

      // Generate title from most frequent entities
      const sortedEntities = entityIds
        .map(id => this.entities.get(id))
        .filter(Boolean)
        .sort((a, b) => b!.frequency - a!.frequency);

      const title = sortedEntities
        .slice(0, 3)
        .map(e => e!.name)
        .join(', ');

      const community: GraphCommunity = {
        id: `community-${uuidv4().slice(0, 8)}`,
        level: 0,
        parentCommunityId: null,
        childCommunityIds: [],
        entityIds,
        relationshipIds: internalRelIds,
        summary: '', // Will be filled by LLM summarization
        findings: [],
        importance,
        title: title || `Community ${communityIdx}`,
        createdAt: now,
      };

      this.communities.set(community.id, community);
    }

    // Build hierarchy: create higher-level communities by merging small ones
    await this.buildCommunityHierarchy();

    return this.communities.size;
  }

  private async buildCommunityHierarchy(): Promise<void> {
    const maxLevels = this.config.maxCommunityLevels ?? 3;
    const now = new Date().toISOString();

    for (let level = 1; level < maxLevels; level++) {
      const prevLevelCommunities = Array.from(this.communities.values())
        .filter(c => c.level === level - 1);

      if (prevLevelCommunities.length <= 1) break;

      // Build a meta-graph of communities (reuse already-resolved constructor)
      const MetaGraphCtor = await resolveGraph();
      const metaGraph = new MetaGraphCtor({ multi: false, type: 'undirected' });
      for (const comm of prevLevelCommunities) {
        metaGraph.addNode(comm.id);
      }

      // Add edges between communities that share relationships
      for (let i = 0; i < prevLevelCommunities.length; i++) {
        for (let j = i + 1; j < prevLevelCommunities.length; j++) {
          const ci = prevLevelCommunities[i];
          const cj = prevLevelCommunities[j];

          // Count cross-community relationships
          let crossWeight = 0;
          for (const [, rel] of this.relationships) {
            const srcInI = ci.entityIds.includes(rel.sourceEntityId);
            const tgtInJ = cj.entityIds.includes(rel.targetEntityId);
            const srcInJ = cj.entityIds.includes(rel.sourceEntityId);
            const tgtInI = ci.entityIds.includes(rel.targetEntityId);
            if ((srcInI && tgtInJ) || (srcInJ && tgtInI)) {
              crossWeight += rel.weight;
            }
          }

          if (crossWeight > 0) {
            try {
              metaGraph.addEdge(ci.id, cj.id, { weight: crossWeight });
            } catch {
              // Edge may already exist
            }
          }
        }
      }

      if (metaGraph.order < 2 || metaGraph.size === 0) break;

      // Run Louvain on meta-graph (lazy-loaded)
      const metaLouvain = await resolveLouvain();
      const metaCommunities = metaLouvain(metaGraph, {
        resolution: (this.config.communityResolution ?? 1.0) * 0.5, // Coarser at higher levels
      });

      // Group previous-level communities
      const metaGroups = new Map<number, string[]>();
      for (const [commId, metaCommId] of Object.entries(metaCommunities)) {
        const mId = metaCommId as number;
        if (!metaGroups.has(mId)) {
          metaGroups.set(mId, []);
        }
        metaGroups.get(mId)!.push(commId);
      }

      for (const [, childCommIds] of metaGroups) {
        if (childCommIds.length <= 1) continue;

        // Merge entity IDs from child communities
        const allEntityIds: string[] = [];
        const allRelIds: string[] = [];
        let totalImportance = 0;

        for (const childId of childCommIds) {
          const child = this.communities.get(childId);
          if (child) {
            allEntityIds.push(...child.entityIds);
            allRelIds.push(...child.relationshipIds);
            totalImportance += child.importance;
            child.parentCommunityId = `parent-${uuidv4().slice(0, 8)}`;
          }
        }

        const parentTitle = childCommIds
          .map(id => this.communities.get(id)?.title ?? '')
          .filter(Boolean)
          .slice(0, 3)
          .join(' + ');

        const parentId = `community-${uuidv4().slice(0, 8)}`;

        // Set parent ID on children
        for (const childId of childCommIds) {
          const child = this.communities.get(childId);
          if (child) child.parentCommunityId = parentId;
        }

        const parent: GraphCommunity = {
          id: parentId,
          level,
          parentCommunityId: null,
          childCommunityIds: childCommIds,
          entityIds: [...new Set(allEntityIds)],
          relationshipIds: [...new Set(allRelIds)],
          summary: '',
          findings: [],
          importance: totalImportance,
          title: parentTitle,
          createdAt: now,
        };

        this.communities.set(parent.id, parent);
      }
    }
  }

  // ===========================================================================
  // Community Summarization
  // ===========================================================================

  private async generateCommunitySummaries(): Promise<void> {
    if (!this.llmProvider) return;

    // Community IDs are ephemeral (recomputed on each ingest). Keep the vector
    // collection clean so stale communities don't crowd out new hits.
    if (this.vectorStore && this.config.communityCollectionName) {
      try {
        await this.vectorStore.delete(this.config.communityCollectionName, undefined, { deleteAll: true });
      } catch {
        // Best-effort only.
      }
    }

    // Summarize from leaf communities upward
    const levels = new Set(Array.from(this.communities.values()).map(c => c.level));
    const sortedLevels = Array.from(levels).sort((a, b) => a - b);

    for (const level of sortedLevels) {
      const levelCommunities = Array.from(this.communities.values())
        .filter(c => c.level === level && !c.summary);

      for (const community of levelCommunities) {
        try {
          community.summary = await this.summarizeCommunity(community);
          community.findings = this.extractFindings(community.summary);

          // Store community summary embedding in vector store
          if (this.embeddingManager && this.vectorStore && community.summary) {
            const embedResult = await this.embeddingManager.generateEmbeddings({
              texts: `${community.title}: ${community.summary}`,
              modelId: this.config.embeddingModelId,
            });
            if (embedResult.embeddings[0]) {
              await this.vectorStore.upsert(this.config.communityCollectionName!, [{
                id: community.id,
                embedding: embedResult.embeddings[0],
                textContent: `${community.title}: ${community.summary}`,
                metadata: {
                  communityLevel: community.level,
                  entityCount: community.entityIds.length,
                  importance: community.importance,
                },
              }]);
            }
          }
        } catch (error) {
          console.warn(`[GraphRAGEngine] Failed to summarize community ${community.id}:`, error);
        }
      }
    }
  }

  private async summarizeCommunity(community: GraphCommunity): Promise<string> {
    if (!this.llmProvider) return '';

    // Build context from community entities and relationships
    const entityDescriptions = community.entityIds
      .map(id => this.entities.get(id))
      .filter(Boolean)
      .map(e => `- ${e!.name} (${e!.type}): ${e!.description}`)
      .join('\n');

    const relationshipDescriptions = community.relationshipIds
      .map(id => this.relationships.get(id))
      .filter(Boolean)
      .map(r => {
        const src = this.entities.get(r!.sourceEntityId);
        const tgt = this.entities.get(r!.targetEntityId);
        return `- ${src?.name ?? '?'} --[${r!.type}]--> ${tgt?.name ?? '?'}: ${r!.description}`;
      })
      .join('\n');

    // Include child community summaries for higher-level communities
    let childContext = '';
    if (community.childCommunityIds.length > 0) {
      const childSummaries = community.childCommunityIds
        .map(id => this.communities.get(id))
        .filter(Boolean)
        .map(c => `- ${c!.title}: ${c!.summary}`)
        .join('\n');
      childContext = `\nSub-groups:\n${childSummaries}`;
    }

    const prompt = `Summarize the following group of related entities and their relationships.
Provide a concise summary (2-4 sentences) and list 2-3 key findings.

Entities:
${entityDescriptions}

Relationships:
${relationshipDescriptions}
${childContext}

Respond with a clear, informative summary of what this group represents and its significance.`;

    return this.llmProvider.generateText(prompt, {
      maxTokens: this.config.maxSummaryTokens ?? 300,
      temperature: 0,
    });
  }

  private extractFindings(summary: string): string[] {
    // Split summary into sentences as findings
    return summary
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20)
      .slice(0, 5);
  }

  // ===========================================================================
  // Global Search (community summaries)
  // ===========================================================================

  async globalSearch(
    query: string,
    options?: GraphRAGSearchOptions,
  ): Promise<GlobalSearchResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const topK = options?.topK ?? 10;

    // Search community summaries via vector similarity
    let matchedCommunities: Array<{
      communityId: string;
      level: number;
      title: string;
      summary: string;
      relevanceScore: number;
    }> = [];

    if (this.embeddingManager && this.vectorStore) {
      const embeddingStart = Date.now();
      const queryEmbedResult = await this.embeddingManager.generateEmbeddings({
        texts: query,
        modelId: this.config.embeddingModelId,
      });
      const _embeddingTimeMs = Date.now() - embeddingStart;

      const queryEmbedding = queryEmbedResult.embeddings[0];
      if (queryEmbedding) {
        const searchResult = await this.vectorStore.query(
          this.config.communityCollectionName!,
          queryEmbedding,
          {
            topK: topK * 2,
            includeTextContent: true,
            includeMetadata: true,
            minSimilarityScore: options?.minRelevance,
          },
        );

        for (const doc of searchResult.documents) {
          const community = this.communities.get(doc.id);
          if (!community) continue;

          // Filter by community level
          if (options?.communityLevels && !options.communityLevels.includes(community.level)) {
            continue;
          }

          matchedCommunities.push({
            communityId: community.id,
            level: community.level,
            title: community.title,
            summary: community.summary,
            relevanceScore: doc.similarityScore,
          });
        }
      }
    } else {
      // Fallback: text-based matching on community summaries
      const queryLower = query.toLowerCase();
      for (const community of this.communities.values()) {
        const text = `${community.title} ${community.summary}`.toLowerCase();
        if (text.includes(queryLower) || queryLower.split(' ').some(w => text.includes(w))) {
          matchedCommunities.push({
            communityId: community.id,
            level: community.level,
            title: community.title,
            summary: community.summary,
            relevanceScore: 0.5, // Default score for text matching
          });
        }
      }
    }

    // Sort by relevance and take topK
    matchedCommunities.sort((a, b) => b.relevanceScore - a.relevanceScore);
    matchedCommunities = matchedCommunities.slice(0, topK);

    // Synthesize answer from community summaries
    let answer = '';
    if (this.llmProvider && matchedCommunities.length > 0) {
      const summaryContext = matchedCommunities
        .map(c => `[${c.title}] (relevance: ${c.relevanceScore.toFixed(2)})\n${c.summary}`)
        .join('\n\n');

      const synthesisStart = Date.now();
      answer = await this.llmProvider.generateText(
        `Based on the following community summaries, answer the question: "${query}"

${summaryContext}

Provide a comprehensive answer based on the information above.`,
        { maxTokens: 500, temperature: 0 },
      );
      const synthesisTimeMs = Date.now() - synthesisStart;

      // Audit: record graph global search with LLM synthesis
      if (options?.auditCollector) {
        const auditOp = options.auditCollector.startOperation('graph_global');
        auditOp.setGraphDetails({
          entitiesMatched: 0,
          communitiesSearched: this.communities.size,
          traversalTimeMs: Date.now() - startTime,
        });
        auditOp.addSources(matchedCommunities.map(c => ({
          id: c.communityId,
          originalDocumentId: c.communityId,
          content: c.summary,
          relevanceScore: c.relevanceScore,
          source: `community:${c.title}`,
        })));
        // Estimate LLM tokens for synthesis (~4 chars per token)
        const promptChars = summaryContext.length + query.length + 100;
        const completionChars = answer.length;
        auditOp.setTokenUsage({
          embeddingTokens: 0,
          llmPromptTokens: Math.ceil(promptChars / 4),
          llmCompletionTokens: Math.ceil(completionChars / 4),
          totalTokens: Math.ceil((promptChars + completionChars) / 4),
        });
        auditOp.complete(matchedCommunities.length);
      }

      return {
        query,
        answer,
        communitySummaries: matchedCommunities,
        totalCommunitiesSearched: this.communities.size,
        diagnostics: {
          searchTimeMs: Date.now() - startTime,
          synthesisTimeMs,
        },
      };
    }

    // No LLM: return summaries as-is
    answer = matchedCommunities
      .map(c => `${c.title}: ${c.summary}`)
      .join('\n\n');

    // Audit: record graph global search
    if (options?.auditCollector) {
      const auditOp = options.auditCollector.startOperation('graph_global');
      auditOp.setGraphDetails({
        entitiesMatched: 0,
        communitiesSearched: this.communities.size,
        traversalTimeMs: Date.now() - startTime,
      });
      auditOp.addSources(matchedCommunities.map(c => ({
        id: c.communityId,
        originalDocumentId: c.communityId,
        content: c.summary,
        relevanceScore: c.relevanceScore,
        source: `community:${c.title}`,
      })));
      auditOp.complete(matchedCommunities.length);
    }

    return {
      query,
      answer,
      communitySummaries: matchedCommunities,
      totalCommunitiesSearched: this.communities.size,
      diagnostics: { searchTimeMs: Date.now() - startTime },
    };
  }

  // ===========================================================================
  // Local Search (entity + graph traversal)
  // ===========================================================================

  async localSearch(
    query: string,
    options?: GraphRAGSearchOptions,
  ): Promise<LocalSearchResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const topK = options?.topK ?? 10;

    // Step 1: Find relevant entities via vector similarity
    let matchedEntities: Array<GraphEntity & { relevanceScore: number }> = [];

    if (this.embeddingManager && this.vectorStore) {
      const embeddingStart = Date.now();
      const queryEmbedResult = await this.embeddingManager.generateEmbeddings({
        texts: query,
        modelId: this.config.embeddingModelId,
      });
      const _embeddingTimeMs = Date.now() - embeddingStart;

      const queryEmbedding = queryEmbedResult.embeddings[0];
      if (queryEmbedding) {
        const searchResult = await this.vectorStore.query(
          this.config.entityCollectionName!,
          queryEmbedding,
          {
            topK: topK * 2,
            includeTextContent: true,
            includeMetadata: true,
            minSimilarityScore: options?.minRelevance,
          },
        );

        for (const doc of searchResult.documents) {
          const entity = this.entities.get(doc.id);
          if (entity) {
            matchedEntities.push({ ...entity, relevanceScore: doc.similarityScore });
          }
        }
      }
    } else {
      // Fallback: text-based matching
      const queryLower = query.toLowerCase();
      for (const entity of this.entities.values()) {
        const text = `${entity.name} ${entity.description}`.toLowerCase();
        if (text.includes(queryLower) || queryLower.split(' ').some(w => text.includes(w))) {
          matchedEntities.push({ ...entity, relevanceScore: 0.5 });
        }
      }
    }

    matchedEntities.sort((a, b) => b.relevanceScore - a.relevanceScore);
    matchedEntities = matchedEntities.slice(0, topK);

    // Step 2: Graph expansion - find connected entities and relationships
    const graphStart = Date.now();
    const expandedEntityIds = new Set(matchedEntities.map(e => e.id));
    const relatedRelationships: GraphRelationship[] = [];

    for (const entity of matchedEntities) {
      if (!this.graph.hasNode(entity.id)) continue;

      // Get 1-hop neighbors
      const neighbors = this.graph.neighbors(entity.id);
      for (const neighborId of neighbors) {
        expandedEntityIds.add(neighborId);
      }

      // Collect relationships
      for (const [, rel] of this.relationships) {
        if (rel.sourceEntityId === entity.id || rel.targetEntityId === entity.id) {
          relatedRelationships.push(rel);
        }
      }
    }
    const graphTraversalTimeMs = Date.now() - graphStart;

    // Step 3: Find community context for matched entities
    const communityContext: Array<{
      communityId: string;
      title: string;
      summary: string;
      level: number;
    }> = [];

    const seenCommunities = new Set<string>();
    for (const entity of matchedEntities) {
      for (const community of this.communities.values()) {
        if (community.entityIds.includes(entity.id) && !seenCommunities.has(community.id)) {
          seenCommunities.add(community.id);
          communityContext.push({
            communityId: community.id,
            title: community.title,
            summary: community.summary,
            level: community.level,
          });
        }
      }
    }

    // Step 4: Build augmented context string
    const entityContext = matchedEntities
      .map(e => `${e.name} (${e.type}): ${e.description}`)
      .join('\n');

    const relContext = relatedRelationships
      .slice(0, 20)
      .map(r => {
        const src = this.entities.get(r.sourceEntityId);
        const tgt = this.entities.get(r.targetEntityId);
        return `${src?.name ?? '?'} --[${r.type}]--> ${tgt?.name ?? '?'}`;
      })
      .join('\n');

    const commContext = communityContext
      .map(c => `[${c.title}]: ${c.summary}`)
      .join('\n');

    const augmentedContext = [
      '## Entities',
      entityContext,
      '',
      '## Relationships',
      relContext,
      '',
      '## Community Context',
      commContext,
    ].join('\n');

    // Audit: record graph local search
    if (options?.auditCollector) {
      const auditOp = options.auditCollector.startOperation('graph_local');
      auditOp.setGraphDetails({
        entitiesMatched: matchedEntities.length,
        communitiesSearched: seenCommunities.size,
        traversalTimeMs: graphTraversalTimeMs,
      });
      auditOp.addSources(matchedEntities.map(e => ({
        id: e.id,
        originalDocumentId: e.sourceDocumentIds[0] ?? e.id,
        content: `${e.name} (${e.type}): ${e.description}`,
        relevanceScore: e.relevanceScore,
        source: `entity:${e.name}`,
      })));
      auditOp.complete(matchedEntities.length);
    }

    return {
      query,
      entities: matchedEntities,
      relationships: relatedRelationships,
      communityContext,
      augmentedContext,
      diagnostics: {
        searchTimeMs: Date.now() - startTime,
        graphTraversalTimeMs,
      },
    };
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  async getEntities(options?: { type?: string; limit?: number }): Promise<GraphEntity[]> {
    this.ensureInitialized();
    let results = Array.from(this.entities.values());
    if (options?.type) {
      results = results.filter(e => e.type === options.type);
    }
    return results.slice(0, options?.limit ?? 100);
  }

  async getRelationships(entityId: string): Promise<GraphRelationship[]> {
    this.ensureInitialized();
    return Array.from(this.relationships.values()).filter(
      r => r.sourceEntityId === entityId || r.targetEntityId === entityId,
    );
  }

  async getCommunities(level?: number): Promise<GraphCommunity[]> {
    this.ensureInitialized();
    let results = Array.from(this.communities.values());
    if (level !== undefined) {
      results = results.filter(c => c.level === level);
    }
    return results.sort((a, b) => b.importance - a.importance);
  }

  async getStats(): Promise<{
    totalEntities: number;
    totalRelationships: number;
    totalCommunities: number;
    communityLevels: number;
    documentsIngested: number;
  }> {
    this.ensureInitialized();
    const levels = new Set(Array.from(this.communities.values()).map(c => c.level));
    return {
      totalEntities: this.entities.size,
      totalRelationships: this.relationships.size,
      totalCommunities: this.communities.size,
      communityLevels: levels.size,
      documentsIngested: this.ingestedDocumentIds.size,
    };
  }

  async clear(): Promise<void> {
    this.entities.clear();
    this.relationships.clear();
    this.communities.clear();
    this.ingestedDocumentIds.clear();
    this.ingestedDocumentHashes.clear();
    this.documentEntityContributions.clear();
    this.documentRelationshipContributions.clear();
    const ClearGraphCtor = await resolveGraph();
    this.graph = new ClearGraphCtor({ multi: false, type: 'undirected' });

    if (this.persistenceAdapter) {
      await this.persistenceAdapter.exec(`
        DELETE FROM ${this.tablePrefix}document_relationships;
        DELETE FROM ${this.tablePrefix}document_entities;
        DELETE FROM ${this.tablePrefix}entities;
        DELETE FROM ${this.tablePrefix}relationships;
        DELETE FROM ${this.tablePrefix}communities;
        DELETE FROM ${this.tablePrefix}ingested_documents;
      `);
    }
  }

  async shutdown(): Promise<void> {
    if (this.persistenceAdapter) {
      await this.persistAll();
    }
    this.entities.clear();
    this.relationships.clear();
    this.communities.clear();
    this.isInitialized = false;
  }

  // ===========================================================================
  // Persistence (sql-storage-adapter)
  // ===========================================================================

  private async createPersistenceSchema(): Promise<void> {
    if (!this.persistenceAdapter) return;

    await this.persistenceAdapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        properties_json TEXT,
        embedding_json TEXT,
        source_document_ids_json TEXT,
        frequency INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        weight REAL DEFAULT 1.0,
        properties_json TEXT,
        source_document_ids_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_entity_id) REFERENCES ${this.tablePrefix}entities(id),
        FOREIGN KEY (target_entity_id) REFERENCES ${this.tablePrefix}entities(id)
      );

      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}communities (
        id TEXT PRIMARY KEY,
        level INTEGER NOT NULL,
        parent_community_id TEXT,
        child_community_ids_json TEXT,
        entity_ids_json TEXT,
        relationship_ids_json TEXT,
        summary TEXT,
        findings_json TEXT,
        importance REAL DEFAULT 0,
        title TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}ingested_documents (
        document_id TEXT PRIMARY KEY,
        ingested_at TEXT NOT NULL,
        content_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}document_entities (
        document_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_name TEXT,
        entity_type TEXT,
        description TEXT,
        frequency INTEGER NOT NULL,
        PRIMARY KEY (document_id, entity_id)
      );

      CREATE TABLE IF NOT EXISTS ${this.tablePrefix}document_relationships (
        document_id TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        weight REAL NOT NULL,
        PRIMARY KEY (document_id, relationship_id)
      );

      CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}entities_type
        ON ${this.tablePrefix}entities(type);

      CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}entities_name
        ON ${this.tablePrefix}entities(name);

      CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}relationships_source
        ON ${this.tablePrefix}relationships(source_entity_id);

      CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}relationships_target
        ON ${this.tablePrefix}relationships(target_entity_id);

      CREATE INDEX IF NOT EXISTS idx_${this.tablePrefix}communities_level
        ON ${this.tablePrefix}communities(level);
    `);

    // Migration: add content_hash to tables created before the column existed.
    //
    // The column is read first and added only when that read fails. On
    // Postgres an ALTER TABLE takes an ACCESS EXCLUSIVE lock even when the
    // column exists; the lock waits behind every open reader of the table (a
    // pg_dump reads it for its whole run) and later queries queue behind it.
    let hasContentHash = false;
    try {
      await this.persistenceAdapter.get(
        `SELECT content_hash FROM ${this.tablePrefix}ingested_documents LIMIT 0`,
      );
      hasContentHash = true;
    } catch {
      // The column is missing: add it below.
    }
    if (!hasContentHash) {
      try {
        await this.persistenceAdapter.exec(
          `ALTER TABLE ${this.tablePrefix}ingested_documents ADD COLUMN content_hash TEXT;`,
        );
      } catch {
        // ignore duplicate column / unsupported
      }
    }
  }

  private async loadFromPersistence(): Promise<void> {
    if (!this.persistenceAdapter) return;

    // Load entities
    const entityRows = await this.persistenceAdapter.all<any>(
      `SELECT * FROM ${this.tablePrefix}entities`,
    );
    for (const row of entityRows) {
      const entity: GraphEntity = {
        id: row.id,
        name: row.name,
        type: row.type,
        description: row.description ?? '',
        properties: row.properties_json ? JSON.parse(row.properties_json) : {},
        embedding: row.embedding_json ? JSON.parse(row.embedding_json) : undefined,
        sourceDocumentIds: row.source_document_ids_json ? JSON.parse(row.source_document_ids_json) : [],
        frequency: row.frequency ?? 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      this.entities.set(entity.id, entity);
      this.graph.addNode(entity.id, { name: entity.name, type: entity.type });
    }

    // Load relationships
    const relRows = await this.persistenceAdapter.all<any>(
      `SELECT * FROM ${this.tablePrefix}relationships`,
    );
    for (const row of relRows) {
      const rel: GraphRelationship = {
        id: row.id,
        sourceEntityId: row.source_entity_id,
        targetEntityId: row.target_entity_id,
        type: row.type,
        description: row.description ?? '',
        weight: row.weight ?? 1.0,
        properties: row.properties_json ? JSON.parse(row.properties_json) : {},
        sourceDocumentIds: row.source_document_ids_json ? JSON.parse(row.source_document_ids_json) : [],
        createdAt: row.created_at,
      };
      this.relationships.set(rel.id, rel);
      if (this.graph.hasNode(rel.sourceEntityId) && this.graph.hasNode(rel.targetEntityId)) {
        try {
          (this.graph as any).addEdgeWithKey?.(
            rel.id,
            rel.sourceEntityId,
            rel.targetEntityId,
            { id: rel.id, type: rel.type, weight: rel.weight },
          );
          if (!(this.graph as any).addEdgeWithKey) {
            this.graph.addEdge(rel.sourceEntityId, rel.targetEntityId, {
              id: rel.id,
              type: rel.type,
              weight: rel.weight,
            });
          }
        } catch {
          // Edge may already exist
        }
      }
    }

    // Load communities
    const commRows = await this.persistenceAdapter.all<any>(
      `SELECT * FROM ${this.tablePrefix}communities`,
    );
    for (const row of commRows) {
      const community: GraphCommunity = {
        id: row.id,
        level: row.level,
        parentCommunityId: row.parent_community_id ?? null,
        childCommunityIds: row.child_community_ids_json ? JSON.parse(row.child_community_ids_json) : [],
        entityIds: row.entity_ids_json ? JSON.parse(row.entity_ids_json) : [],
        relationshipIds: row.relationship_ids_json ? JSON.parse(row.relationship_ids_json) : [],
        summary: row.summary ?? '',
        findings: row.findings_json ? JSON.parse(row.findings_json) : [],
        importance: row.importance ?? 0,
        title: row.title ?? '',
        createdAt: row.created_at,
      };
      this.communities.set(community.id, community);
    }

    // Load ingested document IDs (and content hashes when available)
    try {
      const docRows = await this.persistenceAdapter.all<any>(
        `SELECT document_id, content_hash FROM ${this.tablePrefix}ingested_documents`,
      );
      for (const row of docRows) {
        this.ingestedDocumentIds.add(row.document_id);
        if (row.content_hash) {
          this.ingestedDocumentHashes.set(row.document_id, String(row.content_hash));
        }
      }
    } catch {
      const docRows = await this.persistenceAdapter.all<any>(
        `SELECT document_id FROM ${this.tablePrefix}ingested_documents`,
      );
      for (const row of docRows) {
        this.ingestedDocumentIds.add(row.document_id);
      }
    }

    // Load per-document contribution tables (if present).
    try {
      const docEntityRows = await this.persistenceAdapter.all<any>(
        `SELECT document_id, entity_id, entity_name, entity_type, description, frequency FROM ${this.tablePrefix}document_entities`,
      );
      for (const row of docEntityRows) {
        const docId = String(row.document_id);
        const entityId = String(row.entity_id);
        const map = this.documentEntityContributions.get(docId) ?? new Map<string, DocumentEntityContribution>();
        map.set(entityId, {
          entityId,
          name: row.entity_name ? String(row.entity_name) : '',
          type: row.entity_type ? String(row.entity_type) : 'concept',
          description: row.description ? String(row.description) : '',
          frequency: Number(row.frequency ?? 1),
        });
        this.documentEntityContributions.set(docId, map);
      }

      const docRelRows = await this.persistenceAdapter.all<any>(
        `SELECT document_id, relationship_id, source_entity_id, target_entity_id, type, description, weight FROM ${this.tablePrefix}document_relationships`,
      );
      for (const row of docRelRows) {
        const docId = String(row.document_id);
        const relationshipId = String(row.relationship_id);
        const map =
          this.documentRelationshipContributions.get(docId) ??
          new Map<string, DocumentRelationshipContribution>();
        map.set(relationshipId, {
          relationshipId,
          sourceEntityId: String(row.source_entity_id),
          targetEntityId: String(row.target_entity_id),
          type: String(row.type),
          description: row.description ? String(row.description) : '',
          weight: Number(row.weight ?? 1.0),
        });
        this.documentRelationshipContributions.set(docId, map);
      }
    } catch {
      // Older persistence states may not have these tables; updates will require a rebuild.
    }
  }

  private async persistAll(): Promise<void> {
    if (!this.persistenceAdapter) return;

    // Keep persistence consistent with in-memory state (communities are recomputed with fresh IDs each ingest).
    await this.persistenceAdapter.exec(`
      DELETE FROM ${this.tablePrefix}document_relationships;
      DELETE FROM ${this.tablePrefix}document_entities;
      DELETE FROM ${this.tablePrefix}communities;
      DELETE FROM ${this.tablePrefix}relationships;
      DELETE FROM ${this.tablePrefix}entities;
      DELETE FROM ${this.tablePrefix}ingested_documents;
    `);

    // Persist ingested document IDs + content hashes first.
    for (const docId of this.ingestedDocumentIds) {
      await this.persistenceAdapter.run(
        `INSERT INTO ${this.tablePrefix}ingested_documents (document_id, ingested_at, content_hash) VALUES (?, ?, ?)`,
        [docId, new Date().toISOString(), this.ingestedDocumentHashes.get(docId) ?? null],
      );
    }

    // Persist entities.
    //
    // `INSERT OR REPLACE` is SQLite-only; Postgres chokes with
    // "syntax error at or near OR" at position 8 (right after
    // "INSERT "). Previously every wilds-ai compile against the
    // production Postgres adapter logged `graphrag_seed_failed`,
    // silently dropping GraphRAG seeds for every new blueprint.
    // The `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` form is
    // portable across Postgres + SQLite >= 3.24 (default since 2018),
    // and the `EXCLUDED.<col>` reference pulls the proposed insert
    // value without re-binding parameters.
    for (const entity of this.entities.values()) {
      await this.persistenceAdapter.run(
        `INSERT INTO ${this.tablePrefix}entities
         (id, name, type, description, properties_json, embedding_json, source_document_ids_json, frequency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           description = EXCLUDED.description,
           properties_json = EXCLUDED.properties_json,
           embedding_json = EXCLUDED.embedding_json,
           source_document_ids_json = EXCLUDED.source_document_ids_json,
           frequency = EXCLUDED.frequency,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at`,
        [
          entity.id,
          entity.name,
          entity.type,
          entity.description,
          JSON.stringify(entity.properties),
          entity.embedding ? JSON.stringify(entity.embedding) : null,
          JSON.stringify(entity.sourceDocumentIds),
          entity.frequency,
          entity.createdAt,
          entity.updatedAt,
        ],
      );
    }

    // Persist relationships (see entity comment above for the
    // INSERT OR REPLACE → ON CONFLICT migration rationale).
    for (const rel of this.relationships.values()) {
      await this.persistenceAdapter.run(
        `INSERT INTO ${this.tablePrefix}relationships
         (id, source_entity_id, target_entity_id, type, description, weight, properties_json, source_document_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           source_entity_id = EXCLUDED.source_entity_id,
           target_entity_id = EXCLUDED.target_entity_id,
           type = EXCLUDED.type,
           description = EXCLUDED.description,
           weight = EXCLUDED.weight,
           properties_json = EXCLUDED.properties_json,
           source_document_ids_json = EXCLUDED.source_document_ids_json,
           created_at = EXCLUDED.created_at`,
        [
          rel.id,
          rel.sourceEntityId,
          rel.targetEntityId,
          rel.type,
          rel.description,
          rel.weight,
          JSON.stringify(rel.properties),
          JSON.stringify(rel.sourceDocumentIds),
          rel.createdAt,
        ],
      );
    }

    // Persist communities (see entity comment above).
    for (const community of this.communities.values()) {
      await this.persistenceAdapter.run(
        `INSERT INTO ${this.tablePrefix}communities
         (id, level, parent_community_id, child_community_ids_json, entity_ids_json, relationship_ids_json, summary, findings_json, importance, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           level = EXCLUDED.level,
           parent_community_id = EXCLUDED.parent_community_id,
           child_community_ids_json = EXCLUDED.child_community_ids_json,
           entity_ids_json = EXCLUDED.entity_ids_json,
           relationship_ids_json = EXCLUDED.relationship_ids_json,
           summary = EXCLUDED.summary,
           findings_json = EXCLUDED.findings_json,
           importance = EXCLUDED.importance,
           title = EXCLUDED.title,
           created_at = EXCLUDED.created_at`,
        [
          community.id,
          community.level,
          community.parentCommunityId,
          JSON.stringify(community.childCommunityIds),
          JSON.stringify(community.entityIds),
          JSON.stringify(community.relationshipIds),
          community.summary,
          JSON.stringify(community.findings),
          community.importance,
          community.title,
          community.createdAt,
        ],
      );
    }

    // Persist per-document contribution tables (used for safe re-ingest updates).
    for (const [docId, entityMap] of this.documentEntityContributions) {
      for (const contrib of entityMap.values()) {
        await this.persistenceAdapter.run(
          `INSERT INTO ${this.tablePrefix}document_entities (document_id, entity_id, entity_name, entity_type, description, frequency)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            docId,
            contrib.entityId,
            contrib.name ?? null,
            contrib.type ?? null,
            contrib.description ?? null,
            contrib.frequency,
          ],
        );
      }
    }

    for (const [docId, relMap] of this.documentRelationshipContributions) {
      for (const contrib of relMap.values()) {
        await this.persistenceAdapter.run(
          `INSERT INTO ${this.tablePrefix}document_relationships (document_id, relationship_id, source_entity_id, target_entity_id, type, description, weight)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            docId,
            contrib.relationshipId,
            contrib.sourceEntityId,
            contrib.targetEntityId,
            contrib.type,
            contrib.description ?? null,
            contrib.weight,
          ],
        );
      }
    }
  }

  private recomputeEntityAggregates(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (!entity) return;

    // Frequency, type, and description are derived from per-document contributions.
    let frequency = 0;
    const typeCounts = new Map<string, number>();
    const descriptions: string[] = [];
    const seenDescriptions = new Set<string>();

    for (const docId of entity.sourceDocumentIds) {
      const contrib = this.documentEntityContributions.get(docId)?.get(entityId);
      if (!contrib) continue;
      const f = Number.isFinite(contrib.frequency) ? contrib.frequency : 1;
      frequency += f;

      const t = (contrib.type || 'concept').toLowerCase();
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + f);

      const desc = (contrib.description || '').trim();
      if (desc && !seenDescriptions.has(desc)) {
        seenDescriptions.add(desc);
        descriptions.push(desc);
      }
    }

    entity.frequency = Math.max(0, frequency);

    if (typeCounts.size > 0) {
      let bestType = entity.type;
      let bestScore = -1;
      for (const [t, score] of typeCounts) {
        if (score > bestScore) {
          bestType = t;
          bestScore = score;
        }
      }
      entity.type = bestType;
    }

    entity.description = descriptions.slice(0, 5).join(' ').trim();
    entity.updatedAt = new Date().toISOString();
  }

  private recomputeRelationshipAggregates(relationshipId: string): void {
    const rel = this.relationships.get(relationshipId);
    if (!rel) return;

    const descriptions: string[] = [];
    const seen = new Set<string>();
    for (const docId of rel.sourceDocumentIds) {
      const contrib = this.documentRelationshipContributions.get(docId)?.get(relationshipId);
      if (!contrib) continue;
      const desc = (contrib.description || '').trim();
      if (desc && !seen.has(desc)) {
        seen.add(desc);
        descriptions.push(desc);
      }
    }
    if (descriptions.length > 0) {
      rel.description = descriptions.slice(0, 5).join(' ').trim();
    }

    try {
      (this.graph as any).setEdgeAttribute?.(relationshipId, 'weight', rel.weight);
    } catch {
      // ignore
    }
  }

  private async hydrateDocumentContributionsFromPersistence(documentId: string): Promise<void> {
    if (!this.persistenceAdapter) return;

    if (!this.documentEntityContributions.has(documentId)) {
      try {
        const rows = await this.persistenceAdapter.all<any>(
          `SELECT entity_id, entity_name, entity_type, description, frequency FROM ${this.tablePrefix}document_entities WHERE document_id = ?`,
          [documentId],
        );
        const map = new Map<string, DocumentEntityContribution>();
        for (const row of rows) {
          const entityId = String(row.entity_id);
          map.set(entityId, {
            entityId,
            name: row.entity_name ? String(row.entity_name) : '',
            type: row.entity_type ? String(row.entity_type) : 'concept',
            description: row.description ? String(row.description) : '',
            frequency: Number(row.frequency ?? 1),
          });
        }
        this.documentEntityContributions.set(documentId, map);
      } catch {
        // ignore
      }
    }

    if (!this.documentRelationshipContributions.has(documentId)) {
      try {
        const rows = await this.persistenceAdapter.all<any>(
          `SELECT relationship_id, source_entity_id, target_entity_id, type, description, weight FROM ${this.tablePrefix}document_relationships WHERE document_id = ?`,
          [documentId],
        );
        const map = new Map<string, DocumentRelationshipContribution>();
        for (const row of rows) {
          const relationshipId = String(row.relationship_id);
          map.set(relationshipId, {
            relationshipId,
            sourceEntityId: String(row.source_entity_id),
            targetEntityId: String(row.target_entity_id),
            type: String(row.type),
            description: row.description ? String(row.description) : '',
            weight: Number(row.weight ?? 1.0),
          });
        }
        this.documentRelationshipContributions.set(documentId, map);
      } catch {
        // ignore
      }
    }
  }

  private async removeDocumentContributions(documentId: string): Promise<{
    touchedEntityIds: Set<string>;
    touchedRelationshipIds: Set<string>;
    entitiesNeedingEmbedding: Set<string>;
  }> {
    await this.hydrateDocumentContributionsFromPersistence(documentId);

    const touchedEntityIds = new Set<string>();
    const touchedRelationshipIds = new Set<string>();
    const entitiesNeedingEmbedding = new Set<string>();

    const entityContribs = this.documentEntityContributions.get(documentId);
    const relContribs = this.documentRelationshipContributions.get(documentId);

    if (!entityContribs && !relContribs) {
      throw new Error(`No contribution records found for document '${documentId}'.`);
    }

    // Remove relationship contributions first (edges depend on nodes).
    if (relContribs) {
      for (const contrib of relContribs.values()) {
        const rel = this.relationships.get(contrib.relationshipId);
        if (!rel) continue;

        rel.weight = (Number.isFinite(rel.weight) ? rel.weight : 0) - contrib.weight;
        rel.sourceDocumentIds = rel.sourceDocumentIds.filter((id) => id !== documentId);
        touchedRelationshipIds.add(rel.id);

        if (rel.weight <= 0 || rel.sourceDocumentIds.length === 0) {
          this.relationships.delete(rel.id);
          try {
            (this.graph as any).dropEdge?.(rel.id);
          } catch {
            // ignore
          }
        } else {
          try {
            (this.graph as any).setEdgeAttribute?.(rel.id, 'weight', rel.weight);
          } catch {
            // ignore
          }
        }
      }
    }

    if (entityContribs) {
      for (const contrib of entityContribs.values()) {
        const entity = this.entities.get(contrib.entityId);
        if (!entity) continue;

        entity.frequency = (Number.isFinite(entity.frequency) ? entity.frequency : 0) - contrib.frequency;
        entity.sourceDocumentIds = entity.sourceDocumentIds.filter((id) => id !== documentId);
        touchedEntityIds.add(entity.id);
        entitiesNeedingEmbedding.add(entity.id);

        if (entity.frequency <= 0 || entity.sourceDocumentIds.length === 0) {
          // Drop any relationships involving this entity.
          for (const [relId, rel] of this.relationships) {
            if (rel.sourceEntityId === entity.id || rel.targetEntityId === entity.id) {
              this.relationships.delete(relId);
              touchedRelationshipIds.add(relId);
              try {
                (this.graph as any).dropEdge?.(relId);
              } catch {
                // ignore
              }
            }
          }

          this.entities.delete(entity.id);
          try {
            (this.graph as any).dropNode?.(entity.id);
          } catch {
            // ignore
          }

          if (this.vectorStore && this.config.entityCollectionName) {
            try {
              await this.vectorStore.delete(this.config.entityCollectionName, [entity.id]);
            } catch {
              // Best-effort only.
            }
          }
        }
      }
    }

    this.documentEntityContributions.delete(documentId);
    this.documentRelationshipContributions.delete(documentId);
    this.ingestedDocumentHashes.delete(documentId);

    return { touchedEntityIds, touchedRelationshipIds, entitiesNeedingEmbedding };
  }
}
