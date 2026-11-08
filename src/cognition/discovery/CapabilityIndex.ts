/**
 * @fileoverview Capability Index — vector index over all capabilities.
 * @module @framers/agentos/discovery/CapabilityIndex
 *
 * Normalizes tools, skills, extensions, and channels into unified
 * CapabilityDescriptor objects, embeds them, and stores them in a
 * vector index for semantic search.
 *
 * Reuses existing infrastructure:
 * - IEmbeddingManager for embedding generation (with LRU cache)
 * - IVectorStore for vector storage (InMemory, HNSW, Qdrant, SQL)
 *
 * Performance targets:
 * - Index build: ~3s for ~100 capabilities (one-time, embedding API calls)
 * - Search: <1ms HNSW lookup + ~50ms embedding cold / <5ms warm
 */

import type { IEmbeddingManager } from '../../core/embeddings/IEmbeddingManager.js';
import type { IVectorStore, VectorDocument, MetadataFilter } from '../../core/vector-store/IVectorStore.js';
import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilitySearchResult,
  CapabilityIndexSources,
} from './types.js';
import { CapabilityEmbeddingStrategy } from './CapabilityEmbeddingStrategy.js';

// ============================================================================
// CAPABILITY INDEX
// ============================================================================

export class CapabilityIndex {
  private readonly descriptors: Map<string, CapabilityDescriptor> = new Map();
  private readonly embeddingStrategy: CapabilityEmbeddingStrategy;
  private built = false;

  constructor(
    private readonly embeddingManager: IEmbeddingManager,
    private readonly vectorStore: IVectorStore,
    private readonly collectionName: string,
    private readonly embeddingModelId?: string,
  ) {
    this.embeddingStrategy = new CapabilityEmbeddingStrategy();
  }

  // ============================================================================
  // INDEX LIFECYCLE
  // ============================================================================

  /**
   * Build the index from all capability sources.
   * Normalizes sources into CapabilityDescriptors, embeds them, and stores
   * in the vector store.
   */
  async buildIndex(sources: CapabilityIndexSources): Promise<void> {
    // 1. Normalize all sources into CapabilityDescriptors
    const descriptors = this.normalizeSources(sources);

    // 2. Store descriptors in memory
    for (const desc of descriptors) {
      this.descriptors.set(desc.id, desc);
    }

    if (descriptors.length === 0) {
      this.built = true;
      return;
    }

    // 3. Embed all capabilities in batches
    const documents = await this.embedDocuments(descriptors);
    if (documents.length === 0) {
      this.built = true;
      return;
    }

    // 4. Create collection if the store supports it
    if (this.vectorStore.createCollection) {
      const dimension = documents[0]?.embedding.length;
      if (dimension) {
        const exists = this.vectorStore.collectionExists
          ? await this.vectorStore.collectionExists(this.collectionName)
          : false;
        if (!exists) {
          await this.vectorStore.createCollection(this.collectionName, dimension, {
            similarityMetric: 'cosine',
          });
        }
      }
    }

    // 5. Upsert into vector store
    await this.vectorStore.upsert(this.collectionName, documents);

    this.built = true;
  }

  /**
   * Incrementally add or update a single capability.
   */
  async upsertCapability(cap: CapabilityDescriptor): Promise<void> {
    await this.upsertCapabilities([cap]);
  }

  /**
   * Add or update several capabilities with one embeddings call.
   *
   * The embedding manager splits the call into provider requests of its batch size (32 unless the
   * model or the manager sets another), so N capabilities cost ceil(N / batch) requests rather
   * than N. When an id appears more than once, the last copy wins, as single upserts in order would
   * leave it. A capability that gets no vector stays in the index without one, as
   * {@link upsertCapability} leaves it.
   *
   * @param caps - The capabilities to add or update.
   * @returns The number of capabilities written to the vector store.
   */
  async upsertCapabilities(caps: readonly CapabilityDescriptor[]): Promise<number> {
    for (const cap of caps) {
      this.descriptors.set(cap.id, cap);
    }

    const documents = await this.embedDocuments(caps);
    if (documents.length === 0) {
      return 0;
    }

    await this.vectorStore.upsert(this.collectionName, documents);
    return documents.length;
  }

  /**
   * Embed capabilities with one embeddings call and return a vector document for each one that got
   * a vector.
   *
   * The embedding manager returns one vector per text it was sent, in the order sent, so the i-th
   * vector belongs to the i-th text. A capability whose embedding text is empty is not sent: the
   * manager drops empty texts before it embeds, which would shift every later vector onto the
   * capability before it.
   */
  private async embedDocuments(caps: readonly CapabilityDescriptor[]): Promise<VectorDocument[]> {
    const latest = new Map<string, CapabilityDescriptor>();
    for (const cap of caps) {
      latest.set(cap.id, cap);
    }

    const pending = Array.from(latest.values())
      .map((cap) => ({ cap, text: this.embeddingStrategy.buildEmbeddingText(cap) }))
      .filter(({ text }) => text.trim() !== '');
    if (pending.length === 0) {
      return [];
    }

    const response = await this.embeddingManager.generateEmbeddings({
      texts: pending.map(({ text }) => text),
      modelId: this.embeddingModelId,
    });

    const documents: VectorDocument[] = [];
    pending.forEach(({ cap, text }, i) => {
      const embedding = response.embeddings[i];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return;
      }
      documents.push({
        id: cap.id,
        embedding,
        metadata: {
          kind: cap.kind,
          name: cap.name,
          category: cap.category,
          available: cap.available,
        },
        textContent: text,
      });
    });
    return documents;
  }

  /**
   * Remove a capability from the index.
   */
  async removeCapability(id: string): Promise<void> {
    this.descriptors.delete(id);
    await this.vectorStore.delete(this.collectionName, [id]);
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  /**
   * Semantic search for capabilities matching a query.
   *
   * @param query - Natural language query (e.g., "search the web for news")
   * @param topK - Number of results to return
   * @param filters - Optional filters by kind, category, availability
   */
  async search(
    query: string,
    topK: number,
    filters?: {
      kind?: CapabilityKind | 'any';
      category?: string;
      onlyAvailable?: boolean;
      excludedCapabilityIds?: string[];
    },
  ): Promise<CapabilitySearchResult[]> {
    if (!this.built || this.descriptors.size === 0) {
      return [];
    }

    // Embed the query
    const queryResponse = await this.embeddingManager.generateEmbeddings({
      texts: query,
      modelId: this.embeddingModelId,
    });
    const queryEmbedding = queryResponse.embeddings[0];
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }

    const normalizedExcludedCapabilityIds = normalizeExcludedCapabilityIds(
      filters?.excludedCapabilityIds,
    );

    // Build metadata filter
    const metadataFilter: MetadataFilter = {};
    if (filters?.kind && filters.kind !== 'any') {
      metadataFilter.kind = filters.kind;
    }
    if (filters?.category) {
      metadataFilter.category = filters.category;
    }
    if (filters?.onlyAvailable) {
      metadataFilter.available = true;
    }

    // Query vector store
    const queryTopK =
      normalizedExcludedCapabilityIds.length > 0
        ? Math.min(
            this.descriptors.size,
            Math.max(topK, topK + normalizedExcludedCapabilityIds.length * 4),
          )
        : topK;
    const result = await this.vectorStore.query(this.collectionName, queryEmbedding, {
      topK: queryTopK,
      filter: Object.keys(metadataFilter).length > 0 ? metadataFilter : undefined,
      includeMetadata: true,
    });

    // Map results back to CapabilityDescriptors
    return result.documents
      .map((doc) => {
        const descriptor = this.descriptors.get(doc.id);
        if (!descriptor) return null;
        if (
          normalizedExcludedCapabilityIds.length > 0 &&
          matchesExcludedCapability(descriptor, normalizedExcludedCapabilityIds)
        ) {
          return null;
        }
        return {
          descriptor,
          score: doc.similarityScore,
        };
      })
      .filter((r): r is CapabilitySearchResult => r !== null)
      .slice(0, topK);
  }

  // ============================================================================
  // ACCESSORS
  // ============================================================================

  /**
   * Get a capability by ID.
   */
  getCapability(id: string): CapabilityDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /**
   * Get all registered capabilities.
   */
  getAllCapabilities(): CapabilityDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  /**
   * Get all capability IDs.
   */
  listIds(): string[] {
    return Array.from(this.descriptors.keys());
  }

  /**
   * Get capabilities grouped by category.
   */
  getByCategory(): Map<string, CapabilityDescriptor[]> {
    const grouped = new Map<string, CapabilityDescriptor[]>();
    for (const desc of this.descriptors.values()) {
      const list = grouped.get(desc.category) ?? [];
      list.push(desc);
      grouped.set(desc.category, list);
    }
    return grouped;
  }

  /**
   * Whether the index has been built.
   */
  isBuilt(): boolean {
    return this.built;
  }

  /**
   * Number of indexed capabilities.
   */
  size(): number {
    return this.descriptors.size;
  }

  /**
   * Get the embedding strategy (for external use by assembler).
   */
  getEmbeddingStrategy(): CapabilityEmbeddingStrategy {
    return this.embeddingStrategy;
  }

  // ============================================================================
  // SOURCE NORMALIZATION
  // ============================================================================

  /**
   * Normalize all sources into CapabilityDescriptor objects.
   */
  normalizeSources(sources: CapabilityIndexSources): CapabilityDescriptor[] {
    const descriptors: CapabilityDescriptor[] = [];

    if (sources.tools) {
      for (const tool of sources.tools) {
        descriptors.push(this.normalizeToolSource(tool));
      }
    }

    if (sources.skills) {
      for (const skill of sources.skills) {
        descriptors.push(this.normalizeSkillSource(skill));
      }
    }

    if (sources.extensions) {
      for (const ext of sources.extensions) {
        descriptors.push(this.normalizeExtensionSource(ext));
      }
    }

    if (sources.channels) {
      for (const ch of sources.channels) {
        descriptors.push(this.normalizeChannelSource(ch));
      }
    }

    if (sources.manifests) {
      for (const manifest of sources.manifests) {
        descriptors.push(manifest);
      }
    }

    return descriptors;
  }

  private normalizeToolSource(tool: NonNullable<CapabilityIndexSources['tools']>[0]): CapabilityDescriptor {
    return {
      id: `tool:${tool.name}`,
      kind: 'tool',
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      category: tool.category ?? 'general',
      tags: [],
      requiredSecrets: [],
      requiredTools: [],
      available: true,
      hasSideEffects: tool.hasSideEffects,
      fullSchema: tool.inputSchema,
      sourceRef: { type: 'tool', toolName: tool.name },
    };
  }

  private normalizeSkillSource(skill: NonNullable<CapabilityIndexSources['skills']>[0]): CapabilityDescriptor {
    return {
      id: `skill:${skill.name}`,
      kind: 'skill',
      name: skill.name,
      displayName: skill.name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      description: skill.description,
      category: skill.category ?? 'general',
      tags: skill.tags ?? [],
      requiredSecrets: skill.requiredSecrets ?? [],
      requiredTools: skill.requiredTools ?? skill.metadata?.requires?.bins ?? [],
      available: true,
      fullContent: skill.content,
      sourceRef: {
        type: 'skill',
        skillName: skill.name,
        skillPath: skill.sourcePath,
      },
    };
  }

  private normalizeExtensionSource(ext: NonNullable<CapabilityIndexSources['extensions']>[0]): CapabilityDescriptor {
    return {
      id: `extension:${ext.name}`,
      kind: 'extension',
      name: ext.name,
      displayName: ext.displayName,
      description: ext.description,
      category: ext.category,
      tags: [],
      requiredSecrets: ext.requiredSecrets ?? [],
      requiredTools: [],
      available: ext.available ?? false,
      sourceRef: {
        type: 'extension',
        packageName: ext.name,
        extensionId: ext.id,
      },
    };
  }

  private normalizeChannelSource(ch: NonNullable<CapabilityIndexSources['channels']>[0]): CapabilityDescriptor {
    return {
      id: `channel:${ch.platform}`,
      kind: 'channel',
      name: ch.platform,
      displayName: ch.displayName,
      description: ch.description,
      category: 'communication',
      tags: ch.capabilities ?? [],
      requiredSecrets: [],
      requiredTools: [],
      available: true,
      sourceRef: { type: 'channel', platform: ch.platform },
    };
  }
}

function normalizeExcludedCapabilityIds(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );
}

function matchesExcludedCapability(
  descriptor: CapabilityDescriptor,
  normalizedExcludedCapabilityIds: string[],
): boolean {
  if (descriptor.kind !== 'skill') {
    return false;
  }

  const aliases = Array.from(
    new Set(
      [
        descriptor.id,
        descriptor.name,
        descriptor.displayName,
        descriptor.sourceRef.type === 'skill' ? descriptor.sourceRef.skillName : '',
      ]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );

  return normalizedExcludedCapabilityIds.some((excludedId) => aliases.includes(excludedId));
}
