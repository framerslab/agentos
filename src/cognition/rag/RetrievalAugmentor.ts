/**
 * @fileoverview Implements the RetrievalAugmentor, the core orchestrator for the
 * AgentOS Retrieval Augmented Generation (RAG) system. It adheres to the
 * `IRetrievalAugmentor` interface.
 *
 * This class is responsible for:
 * - Ingesting documents: Involves chunking, embedding generation via `IEmbeddingManager`,
 * and storage into vector databases via `IVectorStoreManager`.
 * - Retrieving context: Embeds queries, searches relevant vector stores for similar
 * chunks, optionally re-ranks, and formats the results into a context string suitable
 * for augmenting LLM prompts.
 * - Managing document lifecycle (delete, update).
 * - Providing health checks and graceful shutdown.
 *
 * @module backend/agentos/rag/RetrievalAugmentor
 * @see ./IRetrievalAugmentor.ts for the interface definition.
 * @see ../config/RetrievalAugmentorConfiguration.ts for `RetrievalAugmentorServiceConfig`.
 * @see ./IEmbeddingManager.ts
 * @see ./IVectorStoreManager.ts
 */

import { uuidv4 } from '../../core/utils/uuid.js';
import {
  IRetrievalAugmentor,
  RagDocumentInput,
  RagIngestionOptions,
  RagIngestionResult,
  RagRetrievalOptions,
  RagRetrievalResult,
  RagRetrievedChunk,
} from './IRetrievalAugmentor';
import { scopeToMetadataFilter, mergeMetadataFilters } from './scopeFilter.js';
import { RetrievalAugmentorServiceConfig } from '../../core/config/RetrievalAugmentorConfiguration';
import { IEmbeddingManager } from './IEmbeddingManager';
import { IVectorStoreManager } from './IVectorStoreManager';
import { VectorDocument, QueryOptions as VectorStoreQueryOptions, MetadataValue } from './IVectorStore';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { RerankerService } from './reranking/RerankerService';
import type { RerankerRequestConfig } from './reranking/IRerankerService';
import { CohereReranker } from './reranking/providers/CohereReranker';
import { LocalCrossEncoderReranker } from './reranking/providers/LocalCrossEncoderReranker';
import { RAGAuditCollector } from './audit/RAGAuditCollector';
import { HydeRetriever, resolveHydeConfig, type HydeLlmCaller } from './HydeRetriever';
import { SemanticChunker } from './chunking/SemanticChunker';
import {
  evaluateRetrievalConfidence,
  resolveMemoryRetrievalPolicy,
} from './unified/index.js';

const DEFAULT_CONTEXT_JOIN_SEPARATOR = "\n\n---\n\n";
const DEFAULT_MAX_CHARS_FOR_AUGMENTED_PROMPT = 4000;
const DEFAULT_CHUNK_SIZE = 512; // Default characters for basic chunking
const DEFAULT_CHUNK_OVERLAP = 64;  // Default character overlap for basic chunking
const DEFAULT_TOP_K = 5;

/**
 * @class RetrievalAugmentor
 * @implements {IRetrievalAugmentor}
 * Orchestrates the RAG pipeline including ingestion, retrieval, and document management.
 */
export class RetrievalAugmentor implements IRetrievalAugmentor {
  public readonly augmenterId: string;
  private config!: RetrievalAugmentorServiceConfig;
  private embeddingManager!: IEmbeddingManager;
  private vectorStoreManager!: IVectorStoreManager;
  private rerankerService?: RerankerService;
  private isInitialized: boolean = false;

  /**
   * Optional HyDE (Hypothetical Document Embedding) retriever.
   *
   * Created lazily on the first retrieval that enables HyDE, or eagerly when
   * a default LLM caller is supplied via {@link setHydeLlmCaller}.
   *
   * @see HydeRetriever
   */
  private hydeRetriever?: HydeRetriever;

  /**
   * LLM caller function injected by the consumer for HyDE hypothesis
   * generation. Must be set before HyDE retrieval can be used.
   */
  private hydeLlmCaller?: HydeLlmCaller;

  /**
   * Constructs a RetrievalAugmentor instance.
   * It is not operational until `initialize` is successfully called.
   */
  constructor() {
    this.augmenterId = `rag-augmentor-${uuidv4()}`;
  }

  /**
   * @inheritdoc
   */
  public async initialize(
    config: RetrievalAugmentorServiceConfig,
    embeddingManager: IEmbeddingManager,
    vectorStoreManager: IVectorStoreManager,
  ): Promise<void> {
    if (this.isInitialized) {
      console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}) already initialized. Re-initializing.`);
      // Consider if dependencies need to be reset or if this is an error.
    }

    if (!config) {
      throw new GMIError('RetrievalAugmentorServiceConfig cannot be null or undefined.', GMIErrorCode.CONFIG_ERROR, { augmenterId: this.augmenterId });
    }
    if (!embeddingManager) {
      throw new GMIError('IEmbeddingManager dependency cannot be null or undefined.', GMIErrorCode.DEPENDENCY_ERROR, { augmenterId: this.augmenterId, dependency: 'IEmbeddingManager' });
    }
    if (!vectorStoreManager) {
      throw new GMIError('IVectorStoreManager dependency cannot be null or undefined.', GMIErrorCode.DEPENDENCY_ERROR, { augmenterId: this.augmenterId, dependency: 'IVectorStoreManager' });
    }

    this.config = config;
    this.embeddingManager = embeddingManager;
    this.vectorStoreManager = vectorStoreManager;

    // Initialize RerankerService if configured
    if (config.rerankerServiceConfig) {
      this.rerankerService = new RerankerService({
        config: config.rerankerServiceConfig,
      });

      // Auto-register built-in provider implementations when declared in config.
      // Custom providers can still be registered via `registerRerankerProvider()`.
      const autoRegistered: string[] = [];
      for (const providerConfig of config.rerankerServiceConfig.providers) {
        try {
          if (providerConfig.providerId === 'cohere') {
            const apiKey = (providerConfig as any)?.apiKey;
            if (typeof apiKey === 'string' && apiKey.trim()) {
              this.rerankerService.registerProvider(new CohereReranker(providerConfig as any));
              autoRegistered.push('cohere');
            } else {
              console.warn(
                `RetrievalAugmentor (ID: ${this.augmenterId}): Cohere reranker declared but missing apiKey. Skipping auto-registration.`,
              );
            }
          } else if (providerConfig.providerId === 'local') {
            this.rerankerService.registerProvider(new LocalCrossEncoderReranker(providerConfig as any));
            autoRegistered.push('local');
          }
        } catch (e: any) {
          console.warn(
            `RetrievalAugmentor (ID: ${this.augmenterId}): Failed to auto-register reranker provider '${providerConfig.providerId}': ${String(
              e?.message ?? e,
            )}`,
          );
        }
      }

      console.log(
        `RetrievalAugmentor (ID: ${this.augmenterId}): RerankerService initialized (configured: [${config.rerankerServiceConfig.providers
          .map((p) => p.providerId)
          .join(', ')}], auto-registered: [${autoRegistered.join(', ')}])`,
      );
    }

    // Validate category behaviors - ensure targetDataSourceIds exist if specified in mapping
    for (const behavior of this.config.categoryBehaviors) {
        for (const dsId of behavior.targetDataSourceIds) {
            try {
                // This is a conceptual check; actual store existence is up to VSM init.
                // Here, we just check if VSM knows about this dataSourceId mapping.
                if(!this.vectorStoreManager.listDataSourceIds().includes(dsId)){
                     console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}): Category behavior for '${behavior.category}' references dataSourceId '${dsId}' which is not declared in VectorStoreManager's dataSourceConfigs. Retrieval for this category might fail for this source.`);
                }
            } catch (e) {
                // If listDataSourceIds itself fails, VSM might not be initialized.
                // This assumes VSM is initialized before or alongside RA.
                 console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Error while validating dataSourceId '${dsId}' for category '${behavior.category}'. VectorStoreManager might not be ready.`, e);
            }
        }
    }


    this.isInitialized = true;
    console.log(`RetrievalAugmentor (ID: ${this.augmenterId}) initialized successfully.`);
  }

  /**
   * Ensures that the augmenter has been initialized.
   * @private
   * @throws {GMIError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        `RetrievalAugmentor (ID: ${this.augmenterId}) is not initialized. Call initialize() first.`,
        GMIErrorCode.NOT_INITIALIZED,
      );
    }
  }

  /**
   * Register a reranker provider with the RerankerService.
   *
   * Call this after initialization to add reranker providers (e.g., CohereReranker,
   * LocalCrossEncoderReranker) that will be available for reranking operations.
   *
   * @param provider - A reranker provider instance implementing IRerankerProvider
   * @throws {GMIError} If RerankerService is not configured
   *
   * @example
   * ```typescript
   * import { CohereReranker, LocalCrossEncoderReranker } from '@framers/agentos/cognition/rag/reranking';
   *
   * // After initialization
   * augmentor.registerRerankerProvider(new CohereReranker({
   *   providerId: 'cohere',
   *   apiKey: process.env.COHERE_API_KEY!
   * }));
   *
   * augmentor.registerRerankerProvider(new LocalCrossEncoderReranker({
   *   providerId: 'local',
   *   defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
   * }));
   * ```
   */
  public registerRerankerProvider(provider: import('./reranking/IRerankerService').IRerankerProvider): void {
    if (!this.rerankerService) {
      throw new GMIError(
        'Cannot register reranker provider: RerankerService not configured. Set rerankerServiceConfig in RetrievalAugmentorServiceConfig.',
        GMIErrorCode.CONFIG_ERROR,
        { augmenterId: this.augmenterId },
      );
    }
    this.rerankerService.registerProvider(provider);
    console.log(`RetrievalAugmentor (ID: ${this.augmenterId}): Registered reranker provider '${provider.providerId}'`);
  }

  /**
   * Register an LLM caller for HyDE hypothesis generation.
   *
   * HyDE (Hypothetical Document Embedding) improves retrieval quality by
   * generating a hypothetical answer first, then embedding that answer
   * instead of the raw query. The hypothesis is semantically closer to the
   * stored documents, yielding better vector similarity matches.
   *
   * The caller must be set before HyDE-enabled retrieval can be used. Once
   * set, HyDE can be activated per-request via `options.hyde.enabled` on
   * {@link retrieveContext}, or it can be activated globally by passing a
   * default HyDE config.
   *
   * @param llmCaller - An async function that takes `(systemPrompt, userPrompt)`
   *   and returns the LLM completion text. The system prompt contains
   *   instructions for hypothesis generation; the user prompt is the query.
   *
   * @example
   * ```typescript
   * augmentor.setHydeLlmCaller(async (systemPrompt, userPrompt) => {
   *   const response = await openai.chat.completions.create({
   *     model: 'gpt-4o-mini',
   *     messages: [
   *       { role: 'system', content: systemPrompt },
   *       { role: 'user', content: userPrompt },
   *     ],
   *     max_tokens: 200,
   *   });
   *   return response.choices[0].message.content ?? '';
   * });
   * ```
   */
  public setHydeLlmCaller(llmCaller: HydeLlmCaller): void {
    this.hydeLlmCaller = llmCaller;
    // Invalidate any previously-created retriever so the next call rebuilds
    // with the new caller.
    this.hydeRetriever = undefined;
    console.log(
      `RetrievalAugmentor (ID: ${this.augmenterId}): HyDE LLM caller registered.`,
    );
  }

  /**
   * Lazily create (or re-use) a HydeRetriever configured for this augmentor.
   *
   * @param overrides - Per-request HyDE config overrides from
   *   {@link RagRetrievalOptions.hyde}.
   * @returns A configured HydeRetriever, or `undefined` if no LLM caller
   *   has been registered.
   * @private
   */
  private getOrCreateHydeRetriever(
    overrides?: RagRetrievalOptions['hyde'],
  ): HydeRetriever | undefined {
    if (!this.hydeLlmCaller) {
      return undefined;
    }

    // Rebuild when per-request overrides differ from current config or when
    // the retriever hasn't been created yet.
    if (!this.hydeRetriever || overrides) {
      this.hydeRetriever = new HydeRetriever({
        llmCaller: this.hydeLlmCaller,
        embeddingManager: this.embeddingManager,
        config: resolveHydeConfig({
          enabled: true,
          initialThreshold: overrides?.initialThreshold,
          minThreshold: overrides?.minThreshold,
        }),
      });
    }

    return this.hydeRetriever;
  }

  /**
   * @inheritdoc
   */
  public async ingestDocuments(
    documents: RagDocumentInput | RagDocumentInput[],
    options?: RagIngestionOptions,
  ): Promise<RagIngestionResult> {
    this.ensureInitialized();
    const docsArray = Array.isArray(documents) ? documents : [documents];
    if (docsArray.length === 0) {
      return { processedCount: 0, failedCount: 0, ingestedIds: [], errors: [] };
    }

    // For now, synchronous processing. Async requires a job queue.
    if (options?.processAsync) {
      console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}): Asynchronous processing requested but not yet fully implemented. Processing synchronously.`);
    }

    const ingestedDocIds = new Set<string>();
    const effectiveDataSourceIds = new Set<string>();
    const results: RagIngestionResult = {
      processedCount: docsArray.length,
      failedCount: 0,
      ingestedIds: [],
      errors: [],
    };

    const batchSize = options?.batchSize || 32; // Define a reasonable default

    for (let i = 0; i < docsArray.length; i += batchSize) {
      const docBatch = docsArray.slice(i, i + batchSize);
      try {
        await this.processDocumentBatch(docBatch, options, results, ingestedDocIds, effectiveDataSourceIds);
      } catch (batchError: any) {
        console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Critical error processing document batch starting at index ${i}. Batch skipped. Error: ${batchError.message}`, batchError);
        docBatch.forEach(doc => {
          results.errors?.push({
            documentId: doc.id,
            message: `Batch processing failed: ${batchError.message}`,
            details: batchError instanceof GMIError ? batchError.details : batchError.toString(),
          });
          results.failedCount++;
        });
      }
    }

    results.ingestedIds = Array.from(ingestedDocIds);
    results.effectiveDataSourceIds = Array.from(effectiveDataSourceIds);
    return results;
  }

  /**
   * Processes a batch of documents for ingestion.
   * @private
   */
  private async processDocumentBatch(
    docBatch: RagDocumentInput[],
    options: RagIngestionOptions | undefined,
    overallResults: RagIngestionResult,
    ingestedDocIds: Set<string>,
    effectiveDataSourceIds: Set<string>,
  ): Promise<void> {
    const vectorDocumentsToUpsert: VectorDocument[] = [];
    const docIdToChunkCount: Record<string, number> = {};

    for (const doc of docBatch) {
      docIdToChunkCount[doc.id] = 0;
      try {
        const targetDataSourceId = options?.targetDataSourceId || doc.dataSourceId || this.config.defaultDataSourceId;
        if (!targetDataSourceId) {
          throw new GMIError(`No targetDataSourceId specified for document '${doc.id}' and no default configured.`, GMIErrorCode.VALIDATION_ERROR, { documentId: doc.id });
        }
        effectiveDataSourceIds.add(targetDataSourceId);

        const chunks = this.chunkDocument(doc, options);
        docIdToChunkCount[doc.id] = chunks.length;

        const chunkContents = chunks.map(c => c.content);
        let embeddings: number[][] = [];

        if (chunks.length > 0 && doc.embedding && doc.embeddingModelId && chunks.length === 1 && chunks[0].content === doc.content) {
            // Use pre-computed embedding if document is not chunked (or effectively one chunk)
            embeddings = [doc.embedding];
            // Basic validation
            const modelDim = await this.embeddingManager.getEmbeddingDimension(doc.embeddingModelId);
            if(doc.embedding.length !== modelDim) {
                throw new GMIError(`Pre-computed embedding for doc '${doc.id}' has dimension ${doc.embedding.length}, but model '${doc.embeddingModelId}' expects ${modelDim}.`, GMIErrorCode.VALIDATION_ERROR);
            }
        } else if (chunkContents.length > 0) {
            const embeddingModelId =
              options?.embeddingModelId ||
              this.config.defaultEmbeddingModelId ||
              this.config.defaultQueryEmbeddingModelId;
            if (!embeddingModelId) {
                throw new GMIError(`No embeddingModelId specified for document '${doc.id}' and no default configured for ingestion.`, GMIErrorCode.CONFIG_ERROR, { documentId: doc.id });
            }
            const embeddingResponse = await this.embeddingManager.generateEmbeddings({
                texts: chunkContents,
                modelId: embeddingModelId, // Could be further refined by category behavior later
                userId: options?.userId,
            });

            // Handle partial failures from embedding manager
            if (embeddingResponse.errors && embeddingResponse.errors.length > 0) {
                embeddingResponse.errors.forEach(err => {
                    const failedChunkOriginalDocId = chunks[err.textIndex].originalDocumentId;
                    overallResults.errors?.push({
                        documentId: failedChunkOriginalDocId,
                        chunkId: chunks[err.textIndex].id,
                        message: `Embedding generation failed: ${err.message}`,
                        details: err.details,
                    });
                });
            }
            embeddings = embeddingResponse.embeddings; // This array corresponds to chunkContents
        }


        for (let j = 0; j < chunks.length; j++) {
          const chunk = chunks[j];
          const chunkEmbedding = embeddings[j];

          if (!chunkEmbedding || chunkEmbedding.length === 0) {
             // Error for this chunk was already added by embeddingResponse error handling, or if pre-computed was invalid.
             // Ensure this chunk isn't added to vectorDocumentsToUpsert.
             console.warn(`Skipping chunk '${chunk.id}' due to missing or invalid embedding.`);
             continue;
          }

          const chunkMetadata: Record<string, MetadataValue> = {
            ...(doc.metadata ?? {}),
            originalDocumentId: doc.id,
            chunkSequence: j,
          };
          if (doc.source) {
            chunkMetadata.source = doc.source;
          }
          if (doc.language) {
            chunkMetadata.language = doc.language;
          }
          // Enterprise provenance — copy the top-level RagDocumentInput
          // fields onto every chunk so `scopeToMetadataFilter` can filter
          // by them at retrieval time without a separate document table.
          if (doc.tenantId) chunkMetadata.tenantId = doc.tenantId;
          if (doc.aclGroups && doc.aclGroups.length > 0) {
            chunkMetadata.aclGroups = doc.aclGroups;
          }
          if (doc.classification) chunkMetadata.classification = doc.classification;
          if (doc.status) chunkMetadata.status = doc.status;
          if (doc.effectiveDate) chunkMetadata.effectiveDate = doc.effectiveDate;
          if (doc.expiresAt) chunkMetadata.expiresAt = doc.expiresAt;

          vectorDocumentsToUpsert.push({
            id: chunk.id, // Chunk ID
            embedding: chunkEmbedding,
            metadata: chunkMetadata,
            textContent: chunk.content, // Store chunk content
          });
        }
      } catch (error: any) {
        console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Failed to process document '${doc.id}' for ingestion. Error: ${error.message}`, error);
        overallResults.errors?.push({
          documentId: doc.id,
          message: `Document processing failed: ${error.message}`,
          details: error instanceof GMIError ? error.details : error.toString(),
        });
        overallResults.failedCount++;
      }
    } // End loop over docBatch

    if (vectorDocumentsToUpsert.length > 0) {
      // Determine the target data source for this batch (assuming batch goes to one source for simplicity here)
      // A more complex scenario might group by targetDataSourceId if docs in batch can vary.
      const firstDocTargetDataSourceId = options?.targetDataSourceId || docBatch[0]?.dataSourceId || this.config.defaultDataSourceId;
      if (!firstDocTargetDataSourceId) {
           console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): No targetDataSourceId for upserting processed chunks. Batch skipped.`);
           docBatch.forEach(doc => {
                if (!overallResults.errors?.find(e => e.documentId === doc.id)) {
                    overallResults.errors?.push({ documentId: doc.id, message: "Target data source ID could not be determined for upsert." });
                    overallResults.failedCount++;
                }
           });
           return;
      }

      try {
        const { store, collectionName } = await this.vectorStoreManager.getStoreForDataSource(firstDocTargetDataSourceId);
        const upsertResult = await store.upsert(collectionName, vectorDocumentsToUpsert, {
            overwrite: options?.duplicateHandling !== 'skip' && options?.duplicateHandling !== 'error', // Approx
        });

        upsertResult.upsertedIds?.forEach(upsertedChunkId => {
          const originalDocId = vectorDocumentsToUpsert.find(vd => vd.id === upsertedChunkId)?.metadata?.originalDocumentId as string;
          if (originalDocId) {
            ingestedDocIds.add(originalDocId);
          }
        });
        // This count is tricky. If a doc is chunked into 5, and all 5 upsert, is that 1 or 5?
        // Let's count original documents whose chunks were attempted for upsert and had no prior critical error.
        // A doc is "successfully ingested" if all its generated chunks were upserted without error.
        const successfullyProcessedDocIdsInBatch = new Set<string>();
        vectorDocumentsToUpsert.forEach(vd => {
          if (upsertResult.upsertedIds?.includes(vd.id) && vd.metadata?.originalDocumentId) {
            successfullyProcessedDocIdsInBatch.add(vd.metadata.originalDocumentId as string);
          }
        });
        
        // Refined success/failure count based on document-level success
        docBatch.forEach(doc => {
            const numChunks = docIdToChunkCount[doc.id] || 0;
            if (numChunks === 0 && !overallResults.errors?.find(e => e.documentId === doc.id)) {
                // Document produced no chunks (e.g. empty content), or failed before chunking.
                // If no specific error recorded yet, mark as failed.
                // This depends on if empty content doc is an error or just 0 chunks. Assume error if not processed.
                // overallResults.failedCount++; Let prior errors handle this.
                return;
            }
            
            let docChunksAllUpserted = true;
            if (numChunks > 0) {
                for (let k=0; k < numChunks; ++k) {
                    const chunkId = `${doc.id}_chunk_${k}`; // Assuming this naming convention from chunkDocument
                    const chunkInBatchAttempt = vectorDocumentsToUpsert.find(vd => vd.id === chunkId);
                    if (chunkInBatchAttempt) { // Was this chunk part of the upsert attempt?
                        if (!upsertResult.upsertedIds?.includes(chunkId)) {
                            docChunksAllUpserted = false;
                            // Find or add error for this specific chunk if not already present from embedding.
                            if (!overallResults.errors?.find(e => e.chunkId === chunkId)) {
                                const storeError = upsertResult.errors?.find(e => e.id === chunkId);
                                overallResults.errors?.push({
                                    documentId: doc.id,
                                    chunkId: chunkId,
                                    message: storeError?.message || "Chunk failed to upsert into vector store.",
                                    details: storeError?.details,
                                });
                            }
                        }
                    } else {
                        // Chunk was filtered out before upsert (e.g. embedding failed)
                        docChunksAllUpserted = false;
                    }
                }
            } else if (!successfullyProcessedDocIdsInBatch.has(doc.id) && !overallResults.errors?.find((e: any) => e.documentId === doc.id)) {
                // No chunks, wasn't marked successful, no prior error: means it failed pre-chunking or was empty.
                docChunksAllUpserted = false;
                 overallResults.errors?.push({ documentId: doc.id, message: "Document yielded no processable chunks or failed prior to chunking."});
            }


            if (docChunksAllUpserted && numChunks > 0) {
              ingestedDocIds.add(doc.id);
            } else {
              // If not already counted as failed due to pre-chunking error
              const alreadyFailed = overallResults.errors?.some((e: any) => e.documentId === doc.id && e.chunkId === undefined);
              if (!alreadyFailed) {
                overallResults.failedCount++;
              }
            }
        });


        if (upsertResult.errors && upsertResult.errors.length > 0) {
            // These are errors from the vector store for specific chunk IDs
            upsertResult.errors.forEach((storeErr: any) => {
                const originalDocId = vectorDocumentsToUpsert.find(vd => vd.id === storeErr.id)?.metadata?.originalDocumentId as string;
                if (!overallResults.errors?.find((e: any) => e.chunkId === storeErr.id)) { // Avoid duplicate error messages
                    overallResults.errors?.push({
                        documentId: originalDocId || 'Unknown Original Document',
                        chunkId: storeErr.id,
                        message: `Vector store upsert failed: ${storeErr.message}`,
                        details: storeErr.details,
                    });
                }
            });
        }
      } catch (storeError: any) {
        console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Failed to upsert batch to data source '${firstDocTargetDataSourceId}'. Error: ${storeError.message}`, storeError);
        // All docs in this sub-batch for this store are considered failed at this point
        docBatch.forEach(doc => {
          const alreadyFailed = overallResults.errors?.some((e: any) => e.documentId === doc.id && e.chunkId === undefined);
          if (!alreadyFailed) {
            overallResults.failedCount++;
          }
          overallResults.errors?.push({
            documentId: doc.id,
            message: `Failed to upsert to store: ${storeError.message}`,
            details: storeError instanceof GMIError ? storeError.details : storeError.toString(),
          });
        });
      }
    }
  }


  /**
   * Chunks a single document based on the provided or default strategy.
   * @private
   */
  private chunkDocument(doc: RagDocumentInput, options?: RagIngestionOptions): Array<{ id: string; content: string; originalDocumentId: string; sequence: number }> {
    const strategy = options?.chunkingStrategy || this.config.defaultChunkingStrategy || { type: 'none' as const };

    if (strategy.type === 'none') {
      return [{ id: `${doc.id}_chunk_0`, content: doc.content, originalDocumentId: doc.id, sequence: 0 }];
    }

    if (strategy.type === 'recursive_character' || strategy.type === 'fixed_size') {
      // Basic character-based fixed size splitter
      const chunkSize = strategy.chunkSize || DEFAULT_CHUNK_SIZE;
      const chunkOverlap = strategy.chunkOverlap || DEFAULT_CHUNK_OVERLAP;
      const chunks: Array<{ id: string; content: string; originalDocumentId: string; sequence: number }> = [];
      let i = 0;
      let sequence = 0;
      while (i < doc.content.length) {
        const end = Math.min(i + chunkSize, doc.content.length);
        chunks.push({
          id: `${doc.id}_chunk_${sequence}`,
          content: doc.content.substring(i, end),
          originalDocumentId: doc.id,
          sequence: sequence,
        });
        sequence++;
        if (end === doc.content.length) break;
        i += (chunkSize - chunkOverlap);
        if (i >= doc.content.length) break; // Avoid creating empty chunk if overlap is large
      }
      return chunks.length > 0 ? chunks : [{ id: `${doc.id}_chunk_0`, content: doc.content, originalDocumentId: doc.id, sequence: 0 }]; // Ensure at least one chunk if content exists
    }

    if (strategy.type === 'semantic') {
      const semanticChunker = new SemanticChunker({
        targetSize: strategy.chunkSize ?? DEFAULT_CHUNK_SIZE,
        maxSize: (strategy.chunkSize ?? DEFAULT_CHUNK_SIZE) * 2,
        minSize: Math.max(100, Math.floor((strategy.chunkSize ?? DEFAULT_CHUNK_SIZE) / 5)),
        overlap: strategy.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
        preserveCodeBlocks: strategy.strategySpecificParams?.preserveCodeBlocks ?? true,
        respectHeadings: strategy.strategySpecificParams?.respectHeadings ?? true,
      });
      const semanticChunks = semanticChunker.chunk(doc.content, doc.metadata as Record<string, unknown>);
      if (semanticChunks.length === 0) {
        return [{ id: `${doc.id}_chunk_0`, content: doc.content, originalDocumentId: doc.id, sequence: 0 }];
      }
      return semanticChunks.map((sc, idx) => ({
        id: `${doc.id}_chunk_${idx}`,
        content: sc.text,
        originalDocumentId: doc.id,
        sequence: idx,
      }));
    }

    console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}): Unknown chunking strategy '${strategy.type}' for doc '${doc.id}'. Using 'none'.`);
    return [{ id: `${doc.id}_chunk_0`, content: doc.content, originalDocumentId: doc.id, sequence: 0 }];
  }

  /**
   * Applies cross-encoder reranking to retrieved chunks.
   *
   * @param queryText - The user query
   * @param chunks - Retrieved chunks to rerank
   * @param rerankerConfig - Reranking configuration from request options
   * @returns Reranked chunks sorted by cross-encoder relevance scores
   * @private
   */
  private async _applyReranking(
    queryText: string,
    chunks: RagRetrievedChunk[],
    rerankerConfig: NonNullable<RagRetrievalOptions['rerankerConfig']>,
  ): Promise<RagRetrievedChunk[]> {
    if (!this.rerankerService) {
      throw new GMIError(
        'Reranker service not initialized but reranking was requested',
        GMIErrorCode.CONFIG_ERROR,
        { augmenterId: this.augmenterId },
      );
    }

    if (chunks.length === 0) {
      return [];
    }

    const requestConfig: Partial<RerankerRequestConfig> = {
      providerId: rerankerConfig.providerId || this.config.defaultRerankerProviderId,
      modelId: rerankerConfig.modelId || this.config.defaultRerankerModelId,
      topN: rerankerConfig.topN,
      maxDocuments: rerankerConfig.maxDocuments,
      timeoutMs: rerankerConfig.timeoutMs,
      params: rerankerConfig.params,
    };

    return this.rerankerService.rerankChunks(queryText, chunks, requestConfig);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private applyMMR(
    chunks: RagRetrievedChunk[],
    topK: number,
    lambda: number,
  ): RagRetrievedChunk[] {
    if (chunks.length <= 1) return chunks.slice(0, topK);

    const candidates = chunks.slice(0, Math.min(chunks.length, Math.max(topK * 5, topK)));
    const selected: RagRetrievedChunk[] = [];
    const remaining = [...candidates];

    // Start from the most relevant chunk.
    selected.push(remaining.shift()!);

    while (selected.length < topK && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevance = candidate.relevanceScore ?? 0;

        let maxSim = 0;
        if (candidate.embedding && candidate.embedding.length > 0) {
          for (const already of selected) {
            if (!already.embedding || already.embedding.length === 0) continue;
            maxSim = Math.max(maxSim, this.cosineSimilarity(candidate.embedding, already.embedding));
          }
        }

        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
  }

  /**
   * @inheritdoc
   */
  /**
   * Batch-embed arbitrary texts with the augmentor's embedding pipeline.
   * Exposed so consumers (e.g. `CitationVerifier` wired through the agent's
   * `verifyCitations: { retrievalAugmentor }` shortcut) can share the same
   * embedder rather than configuring a second one with a different model.
   */
  public async embedTexts(texts: string[]): Promise<number[][]> {
    this.ensureInitialized();
    if (texts.length === 0) return [];
    const response = await this.embeddingManager.generateEmbeddings({ texts });
    return response.embeddings;
  }

  public async retrieveContext(
    queryText: string,
    options?: RagRetrievalOptions,
  ): Promise<RagRetrievalResult> {
    this.ensureInitialized();
    const diagnostics: RagRetrievalResult['diagnostics'] = { messages: [] };
    const startTime = Date.now();
    const resolvedPolicy = options?.policy ? resolveMemoryRetrievalPolicy(options.policy) : null;
    const requestedTopK = options?.topK ?? resolvedPolicy?.topK ?? DEFAULT_TOP_K;
    const effectiveRerankerConfig =
      options?.rerankerConfig ??
      (resolvedPolicy?.reranker === 'always'
        ? {
            enabled: true,
            topN: requestedTopK,
          }
        : undefined);

    // Audit trail collector (opt-in, zero overhead when disabled)
    const collector = options?.includeAudit
      ? new RAGAuditCollector({ requestId: uuidv4(), query: queryText })
      : undefined;

    // 1. Determine Embedding Model
    const embeddingInfo = await this.embeddingManager.getEmbeddingModelInfo();
    const queryEmbeddingModelId =
      options?.queryEmbeddingModelId ||
      this.config.defaultQueryEmbeddingModelId ||
      embeddingInfo?.modelId;

    if (!queryEmbeddingModelId) {
      throw new GMIError("Could not determine query embedding model ID.", GMIErrorCode.CONFIG_ERROR, { augmenterId: this.augmenterId });
    }

    // 2. HyDE or direct query embedding
    //
    // When HyDE is enabled the pipeline generates a hypothetical answer via
    // LLM, then embeds *that* instead of the raw query. The hypothesis is
    // semantically closer to actual stored documents, improving recall.
    //
    // The HyDE path is chosen when:
    //   (a) `options.hyde.enabled` is explicitly `true`, AND
    //   (b) an LLM caller has been registered via `setHydeLlmCaller()`.
    //
    // If HyDE is requested but no LLM caller is available, we log a
    // warning and fall through to the standard embedding path.
    const useHyde =
      options?.hyde?.enabled === true ||
      resolvedPolicy?.hyde === 'always';
    const hydeRetriever = useHyde
      ? this.getOrCreateHydeRetriever(options?.hyde)
      : undefined;

    let queryEmbedding: number[] | undefined;

    if (hydeRetriever) {
      // ── HyDE path: hypothesis → embed hypothesis → use as query vector ──
      const hydeAuditOp = collector?.startOperation('hyde');

      // Generate hypothesis (or use pre-supplied one)
      let hypothesis: string;
      let hypothesisLatencyMs: number;
      if (options?.hyde?.hypothesis) {
        hypothesis = options.hyde.hypothesis;
        hypothesisLatencyMs = 0;
      } else {
        const hypoResult = await hydeRetriever.generateHypothesis(queryText);
        hypothesis = hypoResult.hypothesis;
        hypothesisLatencyMs = hypoResult.latencyMs;
      }

      // Embed the hypothesis instead of the raw query
      const embeddingStartTime = Date.now();
      const hydeEmbeddingResponse = await this.embeddingManager.generateEmbeddings({
        texts: hypothesis,
        modelId: queryEmbeddingModelId,
        userId: options?.userId,
      });
      diagnostics.embeddingTimeMs = Date.now() - embeddingStartTime;

      if (
        !hydeEmbeddingResponse.embeddings ||
        hydeEmbeddingResponse.embeddings.length === 0 ||
        !hydeEmbeddingResponse.embeddings[0] ||
        hydeEmbeddingResponse.embeddings[0].length === 0
      ) {
        diagnostics.messages?.push(
          'HyDE: Failed to generate hypothesis embedding. Falling back to direct query embedding.',
        );
        // queryEmbedding stays undefined — fall through to standard path.
      } else {
        queryEmbedding = hydeEmbeddingResponse.embeddings[0];

        // Record HyDE diagnostics
        diagnostics.hyde = {
          hypothesis,
          hypothesisLatencyMs,
          effectiveThreshold: resolveHydeConfig(options?.hyde).initialThreshold,
          thresholdSteps: 0,
        };
        diagnostics.messages?.push(
          `HyDE: generated hypothesis (${hypothesisLatencyMs}ms), embedded as query vector.`,
        );

        // Audit: record HyDE operation
        if (hydeAuditOp) {
          const estimatedHypoTokens = Math.ceil(hypothesis.length / 4);
          hydeAuditOp.setTokenUsage({
            embeddingTokens: estimatedHypoTokens,
            llmPromptTokens: Math.ceil(queryText.length / 4) + 60,
            llmCompletionTokens: estimatedHypoTokens,
            totalTokens: estimatedHypoTokens * 2 + 60,
          });
          hydeAuditOp.setHydeDetails({
            hypothesis,
            effectiveThreshold: diagnostics.hyde.effectiveThreshold,
            thresholdSteps: 0,
          });
          hydeAuditOp.complete(1);
        }
      }
    } else if (useHyde) {
      // HyDE was requested but no LLM caller is available.
      diagnostics.messages?.push(
        'HyDE: enabled in options but no LLM caller registered via setHydeLlmCaller(). Using direct query embedding.',
      );
    }

    // Standard embedding path (used when HyDE is disabled OR as HyDE fallback)
    if (!queryEmbedding) {
      const embeddingStartTime = Date.now();
      const embeddingAuditOp = collector?.startOperation('embedding');
      const queryEmbeddingResponse = await this.embeddingManager.generateEmbeddings({
        texts: queryText,
        modelId: queryEmbeddingModelId,
        userId: options?.userId,
      });
      diagnostics.embeddingTimeMs = Date.now() - embeddingStartTime;

      // Audit: record embedding operation
      if (embeddingAuditOp) {
        const estimatedTokens = Math.ceil(queryText.length / 4);
        embeddingAuditOp.setTokenUsage({
          embeddingTokens: estimatedTokens,
          llmPromptTokens: 0,
          llmCompletionTokens: 0,
          totalTokens: estimatedTokens,
        });
        embeddingAuditOp.complete(queryEmbeddingResponse.embeddings?.length ?? 0);
      }

      if (
        !queryEmbeddingResponse.embeddings ||
        queryEmbeddingResponse.embeddings.length === 0 ||
        !queryEmbeddingResponse.embeddings[0] ||
        queryEmbeddingResponse.embeddings[0].length === 0
      ) {
        diagnostics.messages?.push('Failed to generate query embedding or embedding was empty.');
        return {
          queryText,
          retrievedChunks: [],
          augmentedContext: '',
          diagnostics,
        };
      }
      queryEmbedding = queryEmbeddingResponse.embeddings[0];
    }

    // 3. Determine Target Data Sources
    const effectiveDataSourceIds = new Set<string>();
    if (options?.targetDataSourceIds && options.targetDataSourceIds.length > 0) {
      options.targetDataSourceIds.forEach((id: string) => effectiveDataSourceIds.add(id));
    }
    if (options?.targetMemoryCategories && options.targetMemoryCategories.length > 0) {
      options.targetMemoryCategories.forEach((category: string) => {
        const behavior = this.config.categoryBehaviors.find((b: any) => b.category === category);
        behavior?.targetDataSourceIds.forEach((id: string) => effectiveDataSourceIds.add(id));
      });
    }
    if (effectiveDataSourceIds.size === 0) {
      // Fallback to default data source if specified in general config, or all if none
      if (this.config.defaultDataSourceId) {
        effectiveDataSourceIds.add(this.config.defaultDataSourceId);
      } else {
        // Or query all known data sources if no targets and no default
         this.vectorStoreManager.listDataSourceIds().forEach((id: string) => effectiveDataSourceIds.add(id));
         if(effectiveDataSourceIds.size > 0) {
            diagnostics.messages?.push("No specific data sources or categories targeted; querying all available sources.");
         }
      }
    }
     if (effectiveDataSourceIds.size === 0) {
      diagnostics.messages?.push("No target data sources could be determined for the query.");
      return { queryText, retrievedChunks: [], augmentedContext: "", queryEmbedding, diagnostics };
    }
    diagnostics.effectiveDataSourceIds = Array.from(effectiveDataSourceIds);


    // 4. Query Vector Stores
    diagnostics.retrievalTimeMs = 0; // Sum up individual query times
    const allRetrievedChunks: RagRetrievedChunk[] = [];
    diagnostics.dataSourceHits = {};

    for (const dsId of effectiveDataSourceIds) {
      try {
        const { store, collectionName, dimension } = await this.vectorStoreManager.getStoreForDataSource(dsId);
        if (dimension && queryEmbedding.length !== dimension) {
            diagnostics.messages?.push(`Query embedding dimension (${queryEmbedding.length}) mismatches data source '${dsId}' dimension (${dimension}). Skipping this source.`);
            console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}): Query embedding dim ${queryEmbedding.length} vs data source '${dsId}' dim ${dimension}.`);
            continue;
        }

        const categoryBehavior = this.config.categoryBehaviors.find((b: any) => b.targetDataSourceIds.includes(dsId));
        const retrievalOptsFromCat = categoryBehavior?.defaultRetrievalOptions || {};
        const globalRetrievalOpts = this.config.globalDefaultRetrievalOptions || {};

        const effectiveStrategy =
          options?.strategy ??
          retrievalOptsFromCat.strategy ??
          globalRetrievalOpts.strategy ??
          'similarity';

        const effectiveStrategyParams = {
          ...(globalRetrievalOpts.strategyParams ?? {}),
          ...(retrievalOptsFromCat.strategyParams ?? {}),
          ...(options?.strategyParams ?? {}),
        };

        const topKRequested = requestedTopK ?? retrievalOptsFromCat.topK ?? globalRetrievalOpts.topK ?? DEFAULT_TOP_K;

        const includeEmbeddingsRequested =
          options?.includeEmbeddings ?? retrievalOptsFromCat.includeEmbeddings ?? globalRetrievalOpts.includeEmbeddings;
        const includeEmbeddingsForRetrieval = Boolean(includeEmbeddingsRequested) || effectiveStrategy === 'mmr';

        // Compose the final metadata filter:
        //   1. Start with whichever caller-supplied filter wins
        //      (option override > category default > global default).
        //   2. Merge in the scope-derived filter (tenantId / aclGroups /
        //      classification / status / effective-date window). Scope
        //      fields are additive — when both caller and scope set the
        //      same key, the caller wins (they know their domain).
        const callerFilter =
          options?.metadataFilter ?? retrievalOptsFromCat.metadataFilter ?? globalRetrievalOpts.metadataFilter;
        const scopeFilter = scopeToMetadataFilter(options?.scope);
        const mergedFilter = mergeMetadataFilters(callerFilter, scopeFilter);

        const finalQueryOptions: VectorStoreQueryOptions = {
          topK: effectiveStrategy === 'mmr' ? Math.max(topKRequested * 5, topKRequested) : topKRequested,
          filter: mergedFilter,
          includeEmbedding: includeEmbeddingsForRetrieval,
          includeMetadata: true,
          includeTextContent: true,
          minSimilarityScore: options?.strategyParams?.custom?.minSimilarityScore,
        };

        // Audit: start vector query operation
        const vectorAuditOp = collector?.startOperation('vector_query');
        vectorAuditOp?.setRetrievalMethod({
          strategy: effectiveStrategy as 'similarity' | 'mmr' | 'hybrid',
          topK: topKRequested,
          hybridAlpha: effectiveStrategy === 'hybrid' ? (effectiveStrategyParams.hybridAlpha ?? 0.7) : undefined,
          mmrLambda: effectiveStrategy === 'mmr' ? (effectiveStrategyParams.mmrLambda ?? 0.7) : undefined,
        });
        vectorAuditOp?.setDataSourceIds([dsId]);
        vectorAuditOp?.setCollectionIds([collectionName]);

        const dsQueryStartTime = Date.now();
        const queryResult =
          effectiveStrategy === 'hybrid' && typeof store.hybridSearch === 'function'
            ? await store.hybridSearch(collectionName, queryEmbedding, queryText, {
                ...finalQueryOptions,
                alpha: effectiveStrategyParams.hybridAlpha ?? 0.7,
                fusion: effectiveStrategyParams.custom?.fusion,
                rrfK: effectiveStrategyParams.custom?.rrfK,
                lexicalTopK: effectiveStrategyParams.custom?.lexicalTopK,
              })
            : await store.query(collectionName, queryEmbedding, finalQueryOptions);
        diagnostics.retrievalTimeMs += (Date.now() - dsQueryStartTime);

        if(diagnostics.dataSourceHits) diagnostics.dataSourceHits[dsId] = queryResult.documents.length;

        const dsChunks: RagRetrievedChunk[] = [];
        queryResult.documents.forEach((doc: any) => {
          const meta = doc.metadata ?? {};
          const chunk: RagRetrievedChunk = {
            id: doc.id,
            content: doc.textContent || "",
            originalDocumentId: meta.originalDocumentId as string || doc.id,
            dataSourceId: dsId,
            source: meta.source as string,
            metadata: doc.metadata,
            relevanceScore: doc.similarityScore,
            embedding: includeEmbeddingsForRetrieval ? doc.embedding : undefined,
            // Surface enterprise provenance fields as typed top-level
            // properties on the chunk. They were copied onto chunkMetadata
            // at ingest time; re-projecting them gives callers a typed
            // surface without forcing them to read raw metadata keys.
            tenantId: typeof meta.tenantId === 'string' ? meta.tenantId : undefined,
            aclGroups: Array.isArray(meta.aclGroups)
              ? (meta.aclGroups as string[])
              : undefined,
            classification:
              meta.classification === 'public' ||
              meta.classification === 'internal' ||
              meta.classification === 'confidential' ||
              meta.classification === 'restricted'
                ? meta.classification
                : undefined,
            status:
              meta.status === 'active' ||
              meta.status === 'draft' ||
              meta.status === 'archived' ||
              meta.status === 'deprecated'
                ? meta.status
                : undefined,
            effectiveDate: typeof meta.effectiveDate === 'string' ? meta.effectiveDate : undefined,
            expiresAt: typeof meta.expiresAt === 'string' ? meta.expiresAt : undefined,
          };
          dsChunks.push(chunk);
          allRetrievedChunks.push(chunk);
        });

        // Audit: record vector query results and complete
        if (vectorAuditOp) {
          vectorAuditOp.addSources(dsChunks.map(c => ({
            id: c.id,
            originalDocumentId: c.originalDocumentId,
            content: c.content,
            relevanceScore: c.relevanceScore,
            dataSourceId: c.dataSourceId,
            source: c.source,
            metadata: c.metadata as Record<string, unknown>,
          })));
          vectorAuditOp.complete(dsChunks.length);
        }
      } catch (error: any) {
        console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Error querying data source '${dsId}'. Error: ${error.message}`, error);
        diagnostics.messages?.push(`Error querying data source '${dsId}': ${error.message}`);
      }
    }

    // 5. Sort, (Optionally Re-rank: MMR, Cross-Encoder - Future Enhancement)
    // For now, simple sort by relevance score (descending)
    allRetrievedChunks.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    
    // Apply topK again after merging, if different from store-level topK or if specified in general options
    const overallTopK = requestedTopK;
    let processedChunks = allRetrievedChunks.slice(0, overallTopK * effectiveDataSourceIds.size); // Take more initially if merging from many
    processedChunks.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    processedChunks = processedChunks.slice(0, Math.max(overallTopK, 1));

    // MMR diversification (optional)
    const strategyUsed = options?.strategy ?? this.config.globalDefaultRetrievalOptions?.strategy ?? 'similarity';
    if (strategyUsed === 'mmr') {
      const lambdaRaw = options?.strategyParams?.mmrLambda ?? 0.7;
      const lambda = Number.isFinite(lambdaRaw) ? Math.max(0, Math.min(1, lambdaRaw)) : 0.7;
      processedChunks = this.applyMMR(processedChunks, overallTopK, lambda);
    } else {
      processedChunks = processedChunks.slice(0, overallTopK);
    }


    // Cross-encoder reranking step (optional)
    if (effectiveRerankerConfig?.enabled) {
      if (!this.rerankerService) {
        diagnostics.messages?.push("Reranking requested but RerankerService not configured. Skipping reranking step.");
      } else {
        try {
          const rerankAuditOp = collector?.startOperation('rerank');
          const rerankStartTime = Date.now();
          const docsBeforeRerank = processedChunks.length;
          processedChunks = await this._applyReranking(queryText, processedChunks, effectiveRerankerConfig);
          diagnostics.rerankingTimeMs = Date.now() - rerankStartTime;
          diagnostics.messages?.push(`Reranking applied with provider '${effectiveRerankerConfig.providerId || this.config.defaultRerankerProviderId || 'default'}' in ${diagnostics.rerankingTimeMs}ms`);

          // Audit: record reranking operation
          if (rerankAuditOp) {
            rerankAuditOp.setRerankDetails({
              providerId: effectiveRerankerConfig.providerId || this.config.defaultRerankerProviderId || 'default',
              modelId: effectiveRerankerConfig.modelId || this.config.defaultRerankerModelId || 'default',
              documentsReranked: docsBeforeRerank,
            });
            rerankAuditOp.complete(processedChunks.length);
          }
        } catch (rerankError: any) {
          console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Reranking failed. Returning results without reranking. Error: ${rerankError.message}`, rerankError);
          diagnostics.messages?.push(`Reranking failed: ${rerankError.message}. Results returned without reranking.`);
        }
      }
    }
    diagnostics.strategyUsed = strategyUsed;

    // Strip embeddings unless explicitly requested by caller.
    const includeEmbeddingsOutput =
      options?.includeEmbeddings ?? this.config.globalDefaultRetrievalOptions?.includeEmbeddings ?? false;
    if (!includeEmbeddingsOutput) {
      processedChunks.forEach((c) => {
        delete (c as any).embedding;
      });
    }

    if (resolvedPolicy) {
      const confidence = evaluateRetrievalConfidence(processedChunks, {
        adaptive: resolvedPolicy.adaptive,
        minScore: resolvedPolicy.minScore,
      });
      diagnostics.policy = {
        profile: resolvedPolicy.profile,
        confidence,
        escalations: [],
      };
    }


    // 6. Format Context
    const joinSeparator = this.config.contextJoinSeparator ?? DEFAULT_CONTEXT_JOIN_SEPARATOR;
    const maxChars = options?.tokenBudgetForContext /* (if tokens, convert) */ ?? this.config.maxCharsForAugmentedPrompt ?? DEFAULT_MAX_CHARS_FOR_AUGMENTED_PROMPT;
    
    let augmentedContext = "";
    let currentChars = 0;
    for (const chunk of processedChunks) {
      if (!chunk.content) continue;
      const potentialContent = (augmentedContext.length > 0 ? joinSeparator : "") + chunk.content;
      if (currentChars + potentialContent.length <= maxChars) {
        augmentedContext += potentialContent;
        currentChars += potentialContent.length;
      } else {
        // Try to add a partial chunk if it makes sense or just break
        const remainingChars = maxChars - currentChars - (augmentedContext.length > 0 ? joinSeparator.length : 0);
        if (remainingChars > 50) { // Arbitrary minimum to add partial content
            augmentedContext += (augmentedContext.length > 0 ? joinSeparator : "") + chunk.content.substring(0, remainingChars) + "...";
        }
        break;
      }
    }
    diagnostics.totalTokensInContext = augmentedContext.length; // Approximation if not tokenizing

    diagnostics.messages?.push(`Total retrieval pipeline took ${Date.now() - startTime}ms.`);

    // Finalize audit trail if requested
    const auditTrail = collector?.finalize();

    return {
      queryText,
      retrievedChunks: processedChunks,
      augmentedContext,
      queryEmbedding,
      diagnostics,
      auditTrail,
    };
  }

  /**
   * @inheritdoc
   */
  public async deleteDocuments(
    documentIds: string[],
    dataSourceId?: string,
    options?: { ignoreNotFound?: boolean },
  ): Promise<{
    successCount: number;
    failureCount: number;
    errors?: Array<{ documentId: string; message: string; details?: any }>;
  }> {
    this.ensureInitialized();
    if (!documentIds || documentIds.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    let successCount = 0;
    let failureCount = 0;
    const errors: Array<{ documentId: string; message: string; details?: any }> = [];

    const targetDsIds = new Set<string>();
    if (dataSourceId) {
        targetDsIds.add(dataSourceId);
    } else {
        // If no specific dataSourceId, try to delete from all. This might be slow or undesirable.
        // A better approach would be to require dataSourceId or have a mapping.
        // For now, let's assume if no dataSourceId, we iterate through all known sources. This is a placeholder.
        console.warn(`RetrievalAugmentor (ID: ${this.augmenterId}): deleteDocuments called without dataSourceId. This behavior might be inefficient or refined in future versions. Attempting delete across all known data sources.`);
        this.vectorStoreManager.listDataSourceIds().forEach((id: string) => targetDsIds.add(id));
        if (targetDsIds.size === 0) {
            documentIds.forEach(docId => {
                errors.push({ documentId: docId, message: "No data sources available to delete from."});
                failureCount++;
            });
            return { successCount, failureCount, errors };
        }
    }
    
    for (const dsId of targetDsIds) {
        try {
            const { store, collectionName } = await this.vectorStoreManager.getStoreForDataSource(dsId);
            for (const docId of documentIds) {
                let filterDeleteFailed = false;

                try {
                    // Chunks are ingested with `originalDocumentId`, so delete
                    // against that metadata key to remove the full logical document.
                    const filterDeleteResult = await store.delete(collectionName, undefined, {
                        filter: { originalDocumentId: docId },
                    });
                    if (filterDeleteResult.deletedCount > 0) {
                        successCount += filterDeleteResult.deletedCount;
                    } else if (filterDeleteResult.deletedCount < 0) {
                        // Some providers accept the delete request but do not
                        // return an exact count. Count the logical document as handled.
                        successCount += 1;
                    }
                    if (filterDeleteResult.errors) {
                        filterDeleteResult.errors.forEach((err: any) => {
                            errors.push({
                                documentId: docId,
                                message: `Failed to delete chunks for '${docId}' from ${dsId}: ${err.message}`,
                                details: err.details,
                            });
                            failureCount++;
                        });
                    }

                    // If the provider deleted matching chunks (or surfaced concrete
                    // errors), we do not need to fall back to direct ID deletion.
                    if (filterDeleteResult.deletedCount !== 0 || filterDeleteResult.errors?.length) {
                        continue;
                    }
                } catch {
                    filterDeleteFailed = true;
                }

                const deleteResult = await store.delete(collectionName, [docId]);
                successCount += deleteResult.deletedCount;
                if (deleteResult.errors) {
                    deleteResult.errors.forEach((err: any) => {
                        errors.push({
                            documentId: err.id || docId,
                            message: `Failed to delete from ${dsId}: ${err.message}`,
                            details: err.details,
                        });
                        failureCount++;
                    });
                }

                if (
                    filterDeleteFailed &&
                    deleteResult.deletedCount === 0 &&
                    !deleteResult.errors?.length &&
                    !options?.ignoreNotFound
                ) {
                    errors.push({
                        documentId: docId,
                        message: `Unable to confirm deletion for '${docId}' in data source '${dsId}'.`,
                    });
                    failureCount++;
                }
            }
        } catch (error: any) {
            documentIds.forEach(docId => {
                 errors.push({ documentId: docId, message: `Error deleting from data source '${dsId}': ${error.message}`, details: error });
                 failureCount++;
            });
        }
    }
    // This success/failure count is based on chunk IDs if documentIds are chunk IDs.
    // If documentIds are original doc IDs, true success is more complex.

    return { successCount, failureCount, errors };
  }

  /**
   * @inheritdoc
   */
  public async updateDocuments(
    documents: RagDocumentInput | RagDocumentInput[],
    options?: RagIngestionOptions,
  ): Promise<RagIngestionResult> {
    this.ensureInitialized();
    const docsArray = Array.isArray(documents) ? documents : [documents];
    const docIdsToUpdate = docsArray.map(doc => doc.id);

    try {
      await this.deleteDocuments(docIdsToUpdate, options?.targetDataSourceId, { ignoreNotFound: true });
    } catch (deleteError: any) {
      console.error(`RetrievalAugmentor (ID: ${this.augmenterId}): Error during delete phase of update for documents [${docIdsToUpdate.join(', ')}]. Ingest will still be attempted. Error: ${deleteError.message}`);
    }

    const ingestionOptionsWithOverwrite = {
      ...options,
      duplicateHandling: 'overwrite' as const, // Force overwrite for update
    };

    return this.ingestDocuments(documents, ingestionOptionsWithOverwrite);
  }

  /**
   * @inheritdoc
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: Record<string, unknown> }> {
    if (!this.isInitialized) {
      return { isHealthy: false, details: { message: `RetrievalAugmentor (ID: ${this.augmenterId}) not initialized.` } };
    }

    const embManagerHealth = await this.embeddingManager.checkHealth();
    const vecStoreManagerHealth = await this.vectorStoreManager.checkHealth();

    const isHealthy = embManagerHealth.isHealthy && vecStoreManagerHealth.isOverallHealthy;

    return {
      isHealthy,
      details: {
        augmenterId: this.augmenterId,
        status: this.isInitialized ? 'Initialized' : 'Not Initialized',
        embeddingManager: embManagerHealth,
        vectorStoreManager: vecStoreManagerHealth,
        configSummary: {
          defaultDataSourceId: this.config.defaultDataSourceId,
          defaultQueryEmbeddingModelId: this.config.defaultQueryEmbeddingModelId,
          categoryBehaviorCount: this.config.categoryBehaviors.length,
        },
      },
    };
  }

  /**
   * @inheritdoc
   */
  public async shutdown(): Promise<void> {
    if (!this.isInitialized) {
      console.log(`RetrievalAugmentor (ID: ${this.augmenterId}): Shutdown called but not initialized.`);
      return;
    }
    console.log(`RetrievalAugmentor (ID: ${this.augmenterId}): Shutting down...`);
    // Assuming EmbeddingManager and VectorStoreManager are shared and their lifecycle managed externally,
    // or if this Augmentor "owns" them, it should shut them down.
    // For now, let's assume they are managed externally or have their own robust shutdown.
    // If they were created by this augmenter, it would be:
    // await this.embeddingManager.shutdown?.();
    // await this.vectorStoreManager.shutdownAllProviders?.();
    this.isInitialized = false;
    console.log(`RetrievalAugmentor (ID: ${this.augmenterId}) shut down.`);
  }
}
