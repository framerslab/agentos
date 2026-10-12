/**
 * @file AgencyMemoryManager.ts
 * @description Manages shared RAG memory for Agency (multi-GMI) collectives.
 * Enables GMIs within an agency to share context, collaborate effectively,
 * and maintain collective memory across conversations.
 *
 * @module AgentOS/Agency
 * @version 1.0.0
 *
 * @example
 * ```typescript
 * const memoryManager = new AgencyMemoryManager(vectorStoreManager, logger);
 *
 * // Initialize shared memory for an agency
 * await memoryManager.initializeAgencyMemory(agencySession);
 *
 * // Ingest document to shared memory
 * await memoryManager.ingestToSharedMemory(agencyId, {
 *   content: 'Important context from GMI-1',
 *   contributorGmiId: 'gmi-1',
 *   contributorRoleId: 'researcher',
 * });
 *
 * // Query shared memory
 * const results = await memoryManager.querySharedMemory(agencyId, {
 *   query: 'What did the researcher find?',
 *   requestingGmiId: 'gmi-2',
 *   requestingRoleId: 'analyst',
 * });
 * ```
 */

import type { ILogger } from '../../core/logging/ILogger';
import type { IVectorStoreManager } from '../../core/vector-store/IVectorStoreManager';
import type { VectorDocument, MetadataFilter, RetrievedVectorDocument } from '../../core/vector-store/IVectorStore';
import type {
  AgencySession,
  AgencyMemoryConfig,
  AgencyMemoryOperationResult,
  AgencyMemoryQueryOptions,
} from './AgencyTypes';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for ingesting documents to agency shared memory.
 */
export interface AgencyMemoryIngestInput {
  /** Document content */
  content: string;
  /** GMI that contributed this content */
  contributorGmiId: string;
  /** Role of the contributing GMI */
  contributorRoleId: string;
  /** Document category */
  category?: 'communication' | 'finding' | 'decision' | 'summary' | 'context';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Optional pre-computed embedding */
  embedding?: number[];
}

/**
 * Retrieved chunk from agency shared memory.
 */
export interface AgencyMemoryChunk {
  /** Chunk ID */
  chunkId: string;
  /** Document ID */
  documentId: string;
  /** Content text */
  content: string;
  /** Similarity score */
  score: number;
  /** Contributing GMI */
  contributorGmiId: string;
  /** Contributing role */
  contributorRoleId: string;
  /** Document category */
  category: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of querying agency shared memory.
 */
export interface AgencyMemoryQueryResult {
  /** Whether query succeeded */
  success: boolean;
  /** Retrieved chunks */
  chunks: AgencyMemoryChunk[];
  /** Total matching results */
  totalResults: number;
  /** Query processing time in ms */
  processingTimeMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Statistics for agency memory.
 */
export interface AgencyMemoryStats {
  /** Total documents in shared memory */
  totalDocuments: number;
  /** Total chunks */
  totalChunks: number;
  /** Documents by role */
  documentsByRole: Record<string, number>;
  /** Documents by category */
  documentsByCategory: Record<string, number>;
  /** Last ingestion timestamp */
  lastIngestionAt?: string;
}

// ============================================================================
// AgencyMemoryManager Implementation
// ============================================================================

/** Default embedding dimension for agency memory */
const DEFAULT_EMBEDDING_DIMENSION = 1536;

/**
 * Generates a simple hash-based embedding for text content.
 * This is a placeholder - in production, use a proper embedding model.
 */
function generateSimpleEmbedding(text: string, dimension: number = DEFAULT_EMBEDDING_DIMENSION): number[] {
  const embedding = new Array(dimension).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    embedding[i % dimension] += charCode / 1000;
  }
  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0)) || 1;
  return embedding.map(val => val / magnitude);
}

/**
 * Manages shared RAG memory for Agency collectives.
 *
 * @remarks
 * This manager provides:
 * - Initialization of dedicated data sources for agencies
 * - Ingestion with role-based access control
 * - Cross-GMI context queries with permission checks
 * - Memory lifecycle management (retention, eviction)
 *
 * Architecture:
 * ```
 * AgencyMemoryManager
 *         │
 *         ├─► VectorStoreManager (storage backend)
 *         │
 *         ├─► AgencyRegistry (session state)
 *         │
 *         └─► Per-Agency Collections
 *              └─► agency-{agencyId}-shared
 * ```
 */
export class AgencyMemoryManager {
  /** Collection name prefix for agency shared memory */
  private static readonly COLLECTION_PREFIX = 'agency-shared-';

  /** Default memory configuration */
  private static readonly DEFAULT_CONFIG: AgencyMemoryConfig = {
    enabled: false,
    autoIngestCommunications: false,
    scoping: {
      includeSharedInQueries: true,
      allowCrossGMIQueries: false,
      sharedMemoryWeight: 0.3,
    },
  };

  /** Tracks initialized agencies */
  private readonly initializedAgencies = new Set<string>();

  /**
   * Creates a new AgencyMemoryManager instance.
   *
   * @param vectorStoreManager - Vector store manager for RAG operations
   * @param logger - Optional logger for diagnostics
   */
  constructor(
    private readonly vectorStoreManager: IVectorStoreManager | null,
    private readonly logger?: ILogger,
  ) {
    if (!vectorStoreManager) {
      this.logger?.warn?.('AgencyMemoryManager created without VectorStoreManager - shared memory disabled');
    }
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initializes shared memory for an agency.
   * Creates dedicated collection and applies configuration.
   *
   * @param session - Agency session to initialize memory for
   * @returns Operation result
   */
  public async initializeAgencyMemory(session: AgencySession): Promise<AgencyMemoryOperationResult> {
    const config = this.resolveConfig(session.memoryConfig);

    if (!config.enabled) {
      return {
        success: true,
        documentsAffected: 0,
        metadata: { reason: 'Agency memory not enabled' },
      };
    }

    if (!this.vectorStoreManager) {
      return {
        success: false,
        documentsAffected: 0,
        error: 'VectorStoreManager not available',
      };
    }

    try {
      const collectionId = this.getCollectionId(session.agencyId);

      // Check if already initialized
      if (this.initializedAgencies.has(session.agencyId)) {
        this.logger?.debug?.('Agency memory already initialized', { agencyId: session.agencyId });
        return {
          success: true,
          documentsAffected: 0,
          metadata: { alreadyInitialized: true },
        };
      }

      // Create collection via default provider
      const provider = this.vectorStoreManager.getDefaultProvider();
      if (!provider) {
        throw new Error('No default vector store provider available');
      }

      // Ensure collection exists (if provider supports it)
      if (provider.collectionExists && provider.createCollection) {
        const exists = await provider.collectionExists(collectionId);
        if (!exists) {
          await provider.createCollection(collectionId, DEFAULT_EMBEDDING_DIMENSION, {
            providerSpecificParams: {
              agencyId: session.agencyId,
              workflowId: session.workflowId,
              type: 'agency-shared-memory',
              createdAt: new Date().toISOString(),
            },
          });
          this.logger?.info?.('Created agency shared memory collection', {
            agencyId: session.agencyId,
            collectionId,
          });
        }
      }

      this.initializedAgencies.add(session.agencyId);

      return {
        success: true,
        documentsAffected: 0,
        metadata: { collectionId, initialized: true },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to initialize agency memory', {
        agencyId: session.agencyId,
        error: errorMessage,
      });
      return {
        success: false,
        documentsAffected: 0,
        error: errorMessage,
      };
    }
  }

  // ==========================================================================
  // Ingestion
  // ==========================================================================

  /**
   * Ingests a document to agency shared memory.
   *
   * @param agencyId - Target agency
   * @param input - Document to ingest
   * @param config - Agency memory configuration
   * @returns Operation result
   */
  public async ingestToSharedMemory(
    agencyId: string,
    input: AgencyMemoryIngestInput,
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryOperationResult> {
    const resolvedConfig = this.resolveConfig(config);

    if (!resolvedConfig.enabled) {
      return {
        success: false,
        documentsAffected: 0,
        error: 'Agency memory not enabled',
      };
    }

    // Check write permissions
    if (resolvedConfig.writeRoles && resolvedConfig.writeRoles.length > 0) {
      if (!resolvedConfig.writeRoles.includes(input.contributorRoleId)) {
        this.logger?.warn?.('GMI role not authorized to write to agency memory', {
          agencyId,
          roleId: input.contributorRoleId,
          allowedRoles: resolvedConfig.writeRoles,
        });
        return {
          success: false,
          documentsAffected: 0,
          error: `Role '${input.contributorRoleId}' not authorized to write to agency shared memory`,
        };
      }
    }

    if (!this.vectorStoreManager) {
      return {
        success: false,
        documentsAffected: 0,
        error: 'VectorStoreManager not available',
      };
    }

    try {
      const provider = this.vectorStoreManager.getDefaultProvider();
      if (!provider) {
        throw new Error('No default vector store provider available');
      }

      const collectionId = this.getCollectionId(agencyId);
      const documentId = `agency-${agencyId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Generate or use provided embedding
      const embedding = input.embedding || generateSimpleEmbedding(input.content);

      // Create VectorDocument
      const document: VectorDocument = {
        id: documentId,
        embedding,
        textContent: input.content,
        metadata: {
          agencyId,
          contributorGmiId: input.contributorGmiId,
          contributorRoleId: input.contributorRoleId,
          category: input.category || 'context',
          ingestedAt: new Date().toISOString(),
          ...(input.metadata as Record<string, string | number | boolean>),
        },
      };

      // Upsert document with agency-specific metadata
      await provider.upsert(collectionId, [document]);

      this.logger?.debug?.('Ingested document to agency shared memory', {
        agencyId,
        documentId,
        contributorRoleId: input.contributorRoleId,
      });

      return {
        success: true,
        documentsAffected: 1,
        metadata: { documentId, collectionId },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to ingest to agency shared memory', {
        agencyId,
        error: errorMessage,
      });
      return {
        success: false,
        documentsAffected: 0,
        error: errorMessage,
      };
    }
  }

  // ==========================================================================
  // Query
  // ==========================================================================

  /**
   * Queries agency shared memory.
   *
   * @param agencyId - Target agency
   * @param options - Query options
   * @param config - Agency memory configuration
   * @returns Query result with retrieved chunks
   */
  public async querySharedMemory(
    agencyId: string,
    options: AgencyMemoryQueryOptions,
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryQueryResult> {
    const startTime = Date.now();
    const resolvedConfig = this.resolveConfig(config);

    if (!resolvedConfig.enabled) {
      return {
        success: false,
        chunks: [],
        totalResults: 0,
        processingTimeMs: Date.now() - startTime,
        error: 'Agency memory not enabled',
      };
    }

    // Check read permissions
    if (resolvedConfig.readRoles && resolvedConfig.readRoles.length > 0) {
      if (!resolvedConfig.readRoles.includes(options.requestingRoleId)) {
        this.logger?.warn?.('GMI role not authorized to read agency memory', {
          agencyId,
          roleId: options.requestingRoleId,
          allowedRoles: resolvedConfig.readRoles,
        });
        return {
          success: false,
          chunks: [],
          totalResults: 0,
          processingTimeMs: Date.now() - startTime,
          error: `Role '${options.requestingRoleId}' not authorized to read agency shared memory`,
        };
      }
    }

    if (!this.vectorStoreManager) {
      return {
        success: false,
        chunks: [],
        totalResults: 0,
        processingTimeMs: Date.now() - startTime,
        error: 'VectorStoreManager not available',
      };
    }

    try {
      const provider = this.vectorStoreManager.getDefaultProvider();
      if (!provider) {
        throw new Error('No default vector store provider available');
      }

      const collectionId = this.getCollectionId(agencyId);

      // Build metadata filter
      const metadataFilter: MetadataFilter = { agencyId };
      if (options.fromRoles && options.fromRoles.length > 0) {
        metadataFilter.contributorRoleId = { $in: options.fromRoles };
      }

      // Generate query embedding from query text
      const queryEmbedding = generateSimpleEmbedding(options.query);

      // Execute query
      const result = await provider.query(collectionId, queryEmbedding, {
        topK: options.topK || 5,
        filter: metadataFilter,
        includeMetadata: true,
        includeTextContent: true,
      });

      // Transform results
      const chunks: AgencyMemoryChunk[] = result.documents.map((doc: RetrievedVectorDocument) => ({
        chunkId: doc.id,
        documentId: doc.id.split('_chunk_')[0] || doc.id,
        content: doc.textContent || '',
        score: doc.similarityScore ?? 0,
        contributorGmiId: (doc.metadata?.contributorGmiId as string) || 'unknown',
        contributorRoleId: (doc.metadata?.contributorRoleId as string) || 'unknown',
        category: (doc.metadata?.category as string) || 'context',
        metadata: doc.metadata as Record<string, unknown>,
      }));

      // Apply threshold filter
      const threshold = options.threshold ?? 0;
      const filteredChunks = chunks.filter((c) => c.score >= threshold);

      this.logger?.debug?.('Queried agency shared memory', {
        agencyId,
        queryLength: options.query.length,
        resultsReturned: filteredChunks.length,
      });

      return {
        success: true,
        chunks: filteredChunks,
        totalResults: filteredChunks.length,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to query agency shared memory', {
        agencyId,
        error: errorMessage,
      });
      return {
        success: false,
        chunks: [],
        totalResults: 0,
        processingTimeMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  // ==========================================================================
  // Statistics & Cleanup
  // ==========================================================================

  /**
   * Gets statistics for agency shared memory.
   *
   * @param agencyId - Target agency
   * @returns Memory statistics
   */
  public async getStats(agencyId: string): Promise<AgencyMemoryStats | null> {
    if (!this.vectorStoreManager) {
      return null;
    }

    try {
      const provider = this.vectorStoreManager.getDefaultProvider();
      if (!provider) {
        return null;
      }

      const collectionId = this.getCollectionId(agencyId);
      
      // Check if getStats is available
      if (!provider.getStats) {
        return {
          totalDocuments: 0,
          totalChunks: 0,
          documentsByRole: {},
          documentsByCategory: {},
        };
      }

      const stats = await provider.getStats(collectionId);
      const totalDocuments = (stats?.documentCount as number) ?? 0;
      const totalChunks = (stats?.vectorCount as number) ?? 0;

      // Aggregate by role and category from metadata when the store supports listing
      const documentsByRole: Record<string, number> = {};
      const documentsByCategory: Record<string, number> = {};
      if (typeof (provider as any).listDocuments === 'function') {
        try {
          const listing = await (provider as any).listDocuments(collectionId, { limit: 5000 });
          for (const doc of listing?.documents ?? []) {
            const role = doc.metadata?.contributorRoleId ?? 'unknown';
            const category = doc.metadata?.category ?? 'uncategorized';
            documentsByRole[role] = (documentsByRole[role] ?? 0) + 1;
            documentsByCategory[category] = (documentsByCategory[category] ?? 0) + 1;
          }
        } catch {
          // Store doesn't support listing — return empty breakdowns
        }
      }

      return { totalDocuments, totalChunks, documentsByRole, documentsByCategory };
    } catch {
      return null;
    }
  }

  /**
   * Cleans up agency memory when agency is removed.
   *
   * @param agencyId - Agency to clean up
   * @returns Operation result
   */
  public async cleanupAgencyMemory(agencyId: string): Promise<AgencyMemoryOperationResult> {
    if (!this.vectorStoreManager) {
      return {
        success: false,
        documentsAffected: 0,
        error: 'VectorStoreManager not available',
      };
    }

    try {
      const provider = this.vectorStoreManager.getDefaultProvider();
      if (!provider) {
        throw new Error('No default vector store provider available');
      }

      const collectionId = this.getCollectionId(agencyId);

      // Delete collection if provider supports it
      if (provider.deleteCollection) {
        await provider.deleteCollection(collectionId);
      }

      this.initializedAgencies.delete(agencyId);

      this.logger?.info?.('Cleaned up agency memory', { agencyId, collectionId });

      return {
        success: true,
        documentsAffected: 0,
        metadata: { collectionDeleted: collectionId },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to cleanup agency memory', {
        agencyId,
        error: errorMessage,
      });
      return {
        success: false,
        documentsAffected: 0,
        error: errorMessage,
      };
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Gets the collection ID for an agency's shared memory.
   */
  private getCollectionId(agencyId: string): string {
    return `${AgencyMemoryManager.COLLECTION_PREFIX}${agencyId}`;
  }

  /**
   * Resolves configuration with defaults.
   */
  private resolveConfig(config?: AgencyMemoryConfig): AgencyMemoryConfig {
    if (!config) {
      return AgencyMemoryManager.DEFAULT_CONFIG;
    }
    return {
      ...AgencyMemoryManager.DEFAULT_CONFIG,
      ...config,
      scoping: {
        ...AgencyMemoryManager.DEFAULT_CONFIG.scoping,
        ...config.scoping,
      },
    };
  }

  /**
   * Checks if agency memory is initialized.
   */
  public isInitialized(agencyId: string): boolean {
    return this.initializedAgencies.has(agencyId);
  }

  // ==========================================================================
  // Cross-GMI Context Sharing
  // ==========================================================================

  /**
   * Broadcasts context from one GMI to all others in the agency.
   * This is useful for sharing discoveries, decisions, or important updates.
   *
   * @param agencyId - Target agency
   * @param input - Broadcast input
   * @param config - Agency memory configuration
   * @returns Operation result with broadcast metadata
   *
   * @example
   * ```typescript
   * await memoryManager.broadcastToAgency(agencyId, {
   *   content: 'Found critical security vulnerability in auth module',
   *   senderGmiId: 'security-analyst-gmi',
   *   senderRoleId: 'security-analyst',
   *   broadcastType: 'finding',
   *   priority: 'high',
   * });
   * ```
   */
  public async broadcastToAgency(
    agencyId: string,
    input: {
      content: string;
      senderGmiId: string;
      senderRoleId: string;
      broadcastType: 'finding' | 'decision' | 'update' | 'request' | 'alert';
      priority?: 'low' | 'normal' | 'high' | 'critical';
      targetRoles?: string[];
      metadata?: Record<string, unknown>;
    },
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryOperationResult> {
    const broadcastDoc: AgencyMemoryIngestInput = {
      content: input.content,
      contributorGmiId: input.senderGmiId,
      contributorRoleId: input.senderRoleId,
      category: input.broadcastType === 'finding' ? 'finding' : 
                input.broadcastType === 'decision' ? 'decision' : 
                'communication',
      metadata: {
        broadcastType: input.broadcastType,
        priority: input.priority || 'normal',
        targetRoles: input.targetRoles || [],
        broadcastAt: new Date().toISOString(),
        ...input.metadata,
      },
    };

    this.logger?.info?.('Broadcasting to agency', {
      agencyId,
      senderRoleId: input.senderRoleId,
      broadcastType: input.broadcastType,
      priority: input.priority,
    });

    return this.ingestToSharedMemory(agencyId, broadcastDoc, config);
  }

  /**
   * Gets recent context contributions from specific roles.
   * Enables GMIs to selectively query context from collaborators.
   *
   * @param agencyId - Target agency
   * @param options - Query options with role filtering
   * @param config - Agency memory configuration
   * @returns Query result filtered by contributor roles
   *
   * @example
   * ```typescript
   * // Get recent findings from the researcher role
   * const findings = await memoryManager.getContextFromRoles(agencyId, {
   *   fromRoles: ['researcher', 'analyst'],
   *   categories: ['finding', 'summary'],
   *   requestingGmiId: 'coordinator-gmi',
   *   requestingRoleId: 'coordinator',
   *   limit: 10,
   * });
   * ```
   */
  public async getContextFromRoles(
    agencyId: string,
    options: {
      fromRoles: string[];
      categories?: ('communication' | 'finding' | 'decision' | 'summary' | 'context')[];
      requestingGmiId: string;
      requestingRoleId: string;
      limit?: number;
      minScore?: number;
    },
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryQueryResult> {
    const queryOptions: AgencyMemoryQueryOptions = {
      query: `Recent contributions from roles: ${options.fromRoles.join(', ')}`,
      requestingGmiId: options.requestingGmiId,
      requestingRoleId: options.requestingRoleId,
      fromRoles: options.fromRoles,
      topK: options.limit || 10,
      threshold: options.minScore || 0,
    };

    return this.querySharedMemory(agencyId, queryOptions, config);
  }

  /**
   * Shares a synthesis or summary across all GMIs in the agency.
   * Typically used by coordinator or synthesizer roles.
   *
   * @param agencyId - Target agency
   * @param summary - Summary content and metadata
   * @param config - Agency memory configuration
   * @returns Operation result
   */
  public async shareSynthesis(
    agencyId: string,
    summary: {
      content: string;
      synthesizerId: string;
      synthesizerRoleId: string;
      sourceRoles?: string[];
      summaryType: 'interim' | 'final' | 'action_items' | 'consensus';
      metadata?: Record<string, unknown>;
    },
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryOperationResult> {
    const synthesisDoc: AgencyMemoryIngestInput = {
      content: summary.content,
      contributorGmiId: summary.synthesizerId,
      contributorRoleId: summary.synthesizerRoleId,
      category: 'summary',
      metadata: {
        summaryType: summary.summaryType,
        sourceRoles: summary.sourceRoles || [],
        synthesizedAt: new Date().toISOString(),
        ...summary.metadata,
      },
    };

    this.logger?.info?.('Sharing synthesis to agency', {
      agencyId,
      synthesizerRoleId: summary.synthesizerRoleId,
      summaryType: summary.summaryType,
    });

    return this.ingestToSharedMemory(agencyId, synthesisDoc, config);
  }

  /**
   * Records a decision made by the agency for future reference.
   *
   * @param agencyId - Target agency
   * @param decision - Decision details
   * @param config - Agency memory configuration
   * @returns Operation result
   */
  public async recordDecision(
    agencyId: string,
    decision: {
      content: string;
      decisionMakerId: string;
      decisionMakerRoleId: string;
      decisionType: 'consensus' | 'delegation' | 'escalation' | 'resolution';
      affectedRoles?: string[];
      rationale?: string;
      metadata?: Record<string, unknown>;
    },
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryOperationResult> {
    const decisionContent = decision.rationale 
      ? `${decision.content}\n\nRationale: ${decision.rationale}`
      : decision.content;

    const decisionDoc: AgencyMemoryIngestInput = {
      content: decisionContent,
      contributorGmiId: decision.decisionMakerId,
      contributorRoleId: decision.decisionMakerRoleId,
      category: 'decision',
      metadata: {
        decisionType: decision.decisionType,
        affectedRoles: decision.affectedRoles || [],
        decidedAt: new Date().toISOString(),
        ...decision.metadata,
      },
    };

    this.logger?.info?.('Recording agency decision', {
      agencyId,
      decisionMakerRoleId: decision.decisionMakerRoleId,
      decisionType: decision.decisionType,
    });

    return this.ingestToSharedMemory(agencyId, decisionDoc, config);
  }

  /**
   * Gets all decisions made by the agency.
   *
   * @param agencyId - Target agency
   * @param options - Query options
   * @param config - Agency memory configuration
   * @returns Query result with decision chunks
   */
  public async getDecisions(
    agencyId: string,
    options: {
      requestingGmiId: string;
      requestingRoleId: string;
      decisionTypes?: ('consensus' | 'delegation' | 'escalation' | 'resolution')[];
      limit?: number;
    },
    config?: AgencyMemoryConfig,
  ): Promise<AgencyMemoryQueryResult> {
    const queryOptions: AgencyMemoryQueryOptions = {
      query: 'Agency decisions and resolutions',
      requestingGmiId: options.requestingGmiId,
      requestingRoleId: options.requestingRoleId,
      topK: options.limit || 20,
      threshold: 0,
    };

    return this.querySharedMemory(agencyId, queryOptions, config);
  }
}
