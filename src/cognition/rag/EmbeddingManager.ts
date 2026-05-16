/**
 * @fileoverview Implements the EmbeddingManager (`EmbeddingManager`), which is responsible
 * for generating vector embeddings for textual content. It adheres to the
 * `IEmbeddingManager` interface.
 *
 * This manager handles configurations for various embedding models, interacts with an
 * `AIModelProviderManager` to make calls to actual LLM providers, and supports
 * features like caching of embeddings and dynamic model selection based on configured strategies.
 * It uses the dedicated `generateEmbeddings` method from the `IProvider` interface for
 * making calls to embedding models.
 *
 * @module backend/agentos/rag/EmbeddingManager
 * @see ./IEmbeddingManager.ts for the interface definition.
 * @see ../config/EmbeddingManagerConfiguration.ts for configuration structures.
 * @see ../core/llm/providers/AIModelProviderManager.ts for provider management.
 * @see ../core/llm/providers/IProvider.ts for the provider contract.
 */

import { LRUCache } from 'lru-cache'; // Popular LRU cache library
import {
  IEmbeddingManager,
  EmbeddingRequest,
  EmbeddingResponse,
} from './IEmbeddingManager';
import {
  EmbeddingManagerConfig,
  EmbeddingModelConfig,
} from '../../core/config/EmbeddingManagerConfiguration';
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import {
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
} from '../../core/llm/providers/IProvider';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js'; // Assuming a GMIError utility

/**
 * Represents a cached embedding entry.
 * @internal
 */
interface CachedEmbedding {
  embedding: number[];
  modelId: string; // The modelId used to generate this embedding
  timestamp: number; // Timestamp of when the embedding was cached
}

/**
 * Implements the `IEmbeddingManager` interface to provide robust embedding generation services.
 *
 * @class EmbeddingManager
 * @implements {IEmbeddingManager}
 */
export class EmbeddingManager implements IEmbeddingManager {
  private config!: EmbeddingManagerConfig;
  private providerManager!: AIModelProviderManager;
  private initialized: boolean = false;
  private availableModels: Map<string, EmbeddingModelConfig>; // modelId -> EmbeddingModelConfig
  private defaultModel?: EmbeddingModelConfig;
  private cache?: LRUCache<string, CachedEmbedding>; // Cache key: typically "modelId:text"

  /**
   * Constructs an EmbeddingManager instance.
   * The manager is not operational until `initialize` is called.
   */
  constructor() {
    this.availableModels = new Map();
  }

  /**
   * @inheritdoc
   */
  public async initialize(
    config: EmbeddingManagerConfig,
    providerManager: AIModelProviderManager,
  ): Promise<void> {
    if (this.initialized) {
      console.warn('EmbeddingManager already initialized. Re-initializing.');
      // Consider cleanup if re-initializing, e.g., clearing cache and models
      this.availableModels.clear();
      (this.cache as any)?.clear?.();
    }

    this.config = config;
    this.providerManager = providerManager;

    if (!config.embeddingModels || config.embeddingModels.length === 0) {
      throw new GMIError(
        'EmbeddingManagerConfig: No embedding models provided. At least one model must be configured.',
        GMIErrorCode.CONFIG_ERROR,
        { modelsCount: 0 }
      );
    }

    config.embeddingModels.forEach(modelConfig => {
      if (!modelConfig.modelId || !modelConfig.providerId || !modelConfig.dimension) {
        console.warn(
          `EmbeddingManager: Invalid or incomplete model configuration skipped: ${JSON.stringify(modelConfig)}. ModelId, providerId, and dimension are required.`,
        );
        return;
      }
      if (modelConfig.dimension <= 0) {
         console.warn(
          `EmbeddingManager: Model configuration for '${modelConfig.modelId}' has an invalid dimension (${modelConfig.dimension}). Skipping.`,
        );
        return;
      }
      this.availableModels.set(modelConfig.modelId, modelConfig);
      if (modelConfig.isDefault) {
        if (this.defaultModel) {
          console.warn(`EmbeddingManager: Multiple default embedding models defined. Using the last one encountered: '${modelConfig.modelId}'. Previous default: '${this.defaultModel.modelId}'.`);
        }
        this.defaultModel = modelConfig;
      }
    });

    // If defaultModelId is specified in config, it takes precedence
    if (config.defaultModelId) {
      const modelFromId = this.availableModels.get(config.defaultModelId);
      if (!modelFromId) {
        throw new GMIError(
          `EmbeddingManagerConfig: Specified defaultModelId '${config.defaultModelId}' does not match any configured embedding model.`,
          GMIErrorCode.CONFIG_ERROR,
          { defaultModelId: config.defaultModelId }
        );
      }
      this.defaultModel = modelFromId;
    }

    // If no default model is set by now (neither by isDefault flag nor defaultModelId),
    // and there are available models, pick the first one as a last resort.
    if (!this.defaultModel && this.availableModels.size > 0) {
      this.defaultModel = this.availableModels.values().next().value;
      console.warn(
        `EmbeddingManager: No default embedding model explicitly set via 'isDefault' or 'defaultModelId'. Using the first available model as default: '${this.defaultModel?.modelId}'.`,
      );
    }

    if (!this.defaultModel) {
      throw new GMIError(
        'EmbeddingManager: No default embedding model could be determined. Ensure at least one model is configured, and optionally specify a default.',
        GMIErrorCode.CONFIG_ERROR,
      );
    }

    if (this.config.enableCache !== false) { // Cache is enabled by default
      const cacheMaxSize = this.config.cacheMaxSize ?? 1000;
      const cacheTTLSeconds = this.config.cacheTTLSeconds ?? 3600; // 1 hour
      this.cache = new LRUCache<string, CachedEmbedding>({
        max: cacheMaxSize,
        ttl: cacheTTLSeconds * 1000, // Convert TTL to milliseconds
      });
      console.debug(
        `EmbeddingManager: Cache enabled (maxSize: ${cacheMaxSize}, ttl: ${cacheTTLSeconds}s).`,
      );
    } else {
      console.debug('EmbeddingManager: Cache is disabled by configuration.');
    }

    this.initialized = true;
    console.debug(
      `EmbeddingManager initialized successfully with ${this.availableModels.size} embedding model(s). Default model: '${this.defaultModel?.modelId}'.`,
    );
  }

  /**
   * Ensures that the manager has been initialized.
   * @private
   * @throws {GMIError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new GMIError(
        'EmbeddingManager is not initialized. Call initialize() before using its methods.',
        GMIErrorCode.NOT_INITIALIZED,
      );
    }
  }

  /**
   * Selects an embedding model based on the request and configured strategy.
   * @private
   * @param {EmbeddingRequest} request - The embedding request.
   * @returns {EmbeddingModelConfig} The selected model configuration.
   * @throws {GMIError} If no suitable model can be selected.
   */
  private selectModel(request: EmbeddingRequest): EmbeddingModelConfig {
    this.ensureInitialized(); // Default model must be available here

    // 1. Explicit modelId in request takes highest precedence
    if (request.modelId) {
      const model = this.availableModels.get(request.modelId);
      if (model) {
        // Optional: Validate if request.providerId matches model.providerId if both are given
        if (request.providerId && request.providerId !== model.providerId) {
          console.warn(
            `EmbeddingManager: Requested providerId '${request.providerId}' for model '${request.modelId}' differs from the model's configured provider '${model.providerId}'. Using the model's configured provider.`,
          );
        }
        return model;
      }
      console.warn(
        `EmbeddingManager: Requested modelId '${request.modelId}' not found among available models. Falling back to selection strategy or default.`,
      );
    }

    const strategyConfig = this.config.selectionStrategy;
    let selectedModel: EmbeddingModelConfig | undefined;

    // 2. Apply selection strategy if defined
    if (strategyConfig) {
      switch (strategyConfig.type) {
        case 'dynamic_quality':
          selectedModel = [...this.availableModels.values()]
            .filter(m => m.qualityScore !== undefined)
            .sort((a, b) => (b.qualityScore!) - (a.qualityScore!))[0];
          break;
        case 'dynamic_cost':
          selectedModel = [...this.availableModels.values()]
            .filter(m => m.pricePer1MTokensUSD !== undefined)
            .sort((a, b) => (a.pricePer1MTokensUSD!) - (b.pricePer1MTokensUSD!))[0];
          break;
        case 'dynamic_collection_preference':
          if (request.collectionId) {
            selectedModel = [...this.availableModels.values()].find(m =>
              m.supportedCollections?.includes(request.collectionId!),
            );
          }
          break;
        case 'static': // Explicitly fall through to default logic
        default:
          // The 'static' strategy or an unknown strategy type will use the fallback or default.
          break;
      }

      // If strategy yielded a model, use it
      if (selectedModel) return selectedModel;

      // If strategy failed, try its fallback model
      if (strategyConfig.fallbackModelId) {
        selectedModel = this.availableModels.get(strategyConfig.fallbackModelId);
        if (selectedModel) return selectedModel;
        console.warn(
          `EmbeddingManager: Selection strategy fallbackModelId '${strategyConfig.fallbackModelId}' not found. Using system default.`,
        );
      }
    }

    // 3. Fallback to the system default model
    if (!this.defaultModel) {
         // This should not happen if initialize() worked correctly.
        throw new GMIError("Critical error: Default embedding model is not set after initialization.", GMIErrorCode.INTERNAL_ERROR);
    }
    return this.defaultModel;
  }

  /**
   * @inheritdoc
   */
  public async generateEmbeddings(
    request: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    this.ensureInitialized();

    const textsToEmbed = Array.isArray(request.texts)
      ? request.texts.filter(text => typeof text === 'string' && text.trim() !== '') // Filter out empty or invalid texts
      : (typeof request.texts === 'string' && request.texts.trim() !== '' ? [request.texts] : []);


    if (textsToEmbed.length === 0) {
      // If all input texts were empty or invalid, or if an empty array was passed.
      const modelForEmptyResponse = this.selectModel(request); // Still select a model to report its ID
      return {
        embeddings: [],
        modelId: modelForEmptyResponse.modelId,
        providerId: modelForEmptyResponse.providerId,
        usage: { inputTokens: 0, totalTokens: 0, costUSD: 0 },
      };
    }

    const selectedModelConfig = this.selectModel(request);
    const provider = this.providerManager.getProvider(selectedModelConfig.providerId);

    if (!provider) {
      throw new GMIError(
        `LLM Provider '${selectedModelConfig.providerId}' configured for embedding model '${selectedModelConfig.modelId}' not found or not available.`,
        GMIErrorCode.PROVIDER_NOT_FOUND,
        { providerId: selectedModelConfig.providerId, modelId: selectedModelConfig.modelId }
      );
    }
    if (typeof provider.generateEmbeddings !== 'function') {
      throw new GMIError(
        `LLM Provider '${selectedModelConfig.providerId}' does not support the 'generateEmbeddings' method required by model '${selectedModelConfig.modelId}'.`,
        GMIErrorCode.METHOD_NOT_SUPPORTED,
        { providerId: selectedModelConfig.providerId, method: 'generateEmbeddings' }
      );
    }

    const finalEmbeddings: number[][] = new Array(textsToEmbed.length).fill(null).map(() => []); // Initialize to avoid sparse arrays if errors occur
    const errors: Array<{ textIndex: number; message: string; details?: any }> = [];
    let cumulativeInputTokens = 0;
    let cumulativeTotalTokens = 0;
    let cumulativeCostUSD = 0;

    const batchSize = selectedModelConfig.providerSpecificArgs?.batchSize ?? this.config.defaultBatchSize ?? 32;

    for (let i = 0; i < textsToEmbed.length; i += batchSize) {
      const batchTexts = textsToEmbed.slice(i, i + batchSize);
      const originalIndicesForThisBatch = batchTexts.map((_, idx) => i + idx);

      const textsToFetchFromProvider: string[] = [];
      // Map: index_in_textsToFetchFromProvider -> original_overall_index
      const providerFetchIndexToOriginalIndexMap: number[] = [];

      // Check cache for each text in the current batch
      if (this.cache) {
        for (let j = 0; j < batchTexts.length; j++) {
          const text = batchTexts[j];
          const originalIndex = originalIndicesForThisBatch[j];
          const cacheKey = `${selectedModelConfig.modelId}:${text}`; // Simple cache key
          const cachedEntry = this.cache.get(cacheKey);

          if (cachedEntry && cachedEntry.modelId === selectedModelConfig.modelId) {
            finalEmbeddings[originalIndex] = cachedEntry.embedding;
          } else {
            textsToFetchFromProvider.push(text);
            providerFetchIndexToOriginalIndexMap.push(originalIndex);
          }
        }
      } else {
        textsToFetchFromProvider.push(...batchTexts);
        providerFetchIndexToOriginalIndexMap.push(...originalIndicesForThisBatch);
      }

      if (textsToFetchFromProvider.length > 0) {
        try {
          const providerOptions: ProviderEmbeddingOptions = {
            userId: request.userId,
            customModelParams: selectedModelConfig.providerSpecificArgs,
            // Map relevant fields from EmbeddingModelConfig to ProviderEmbeddingOptions if needed
            // Example: dimensions for OpenAI text-embedding-3 models
            dimensions: selectedModelConfig.providerSpecificArgs?.dimensions as number | undefined,
            // inputType for older OpenAI models if still supported by provider interface
            inputType: selectedModelConfig.providerSpecificArgs?.inputType as any,
          };

          const batchResponse: ProviderEmbeddingResponse = await provider.generateEmbeddings(
            selectedModelConfig.modelId,
            textsToFetchFromProvider,
            providerOptions,
          );

          if (batchResponse.error) {
            // If the whole batch failed at the provider level
            throw new GMIError(batchResponse.error.message, GMIErrorCode.PROVIDER_ERROR, batchResponse.error.details || batchResponse.error);
          }

          if (batchResponse.data && batchResponse.data.length === textsToFetchFromProvider.length) {
            batchResponse.data.forEach((embData, k) => {
              const originalTextIndex = providerFetchIndexToOriginalIndexMap[k];
              if (embData.embedding.length !== selectedModelConfig.dimension) {
                 errors.push({
                    textIndex: originalTextIndex,
                    message: `Provider returned embedding with incorrect dimension ${embData.embedding.length} for model '${selectedModelConfig.modelId}' (expected ${selectedModelConfig.dimension}).`,
                    details: { text: textsToEmbed[originalTextIndex].substring(0, 100) + '...' }
                 });
                 // Do not populate finalEmbeddings[originalTextIndex] if dimension is wrong
              } else {
                finalEmbeddings[originalTextIndex] = embData.embedding;
                if (this.cache) {
                  const cacheKey = `${selectedModelConfig.modelId}:${textsToFetchFromProvider[k]}`;
                  this.cache.set(cacheKey, {
                    embedding: embData.embedding,
                    modelId: selectedModelConfig.modelId,
                    timestamp: Date.now(),
                  });
                }
              }
            });
          } else {
            // Mismatch in expected vs. received embeddings count from provider
             throw new GMIError(
              'Provider returned mismatched number of embeddings for the batch or no data.',
              GMIErrorCode.PROVIDER_ERROR,
              { expected: textsToFetchFromProvider.length, received: batchResponse.data?.length }
            );
          }

          cumulativeInputTokens += batchResponse.usage.prompt_tokens || 0; // Embeddings typically use prompt_tokens
          cumulativeTotalTokens += batchResponse.usage.total_tokens || 0;
          cumulativeCostUSD += batchResponse.usage.costUSD || 0;

        } catch (error: any) {
          const errorMessage = error instanceof GMIError ? error.message : (error.message || 'Unknown error during batch embedding generation.');
          // Log concisely — don't dump full error objects with stack traces for expected failures like network errors
          const isNetworkError = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(errorMessage);
          if (isNetworkError) {
            console.debug(`[Embeddings] Network error — embedding batch skipped (model: ${selectedModelConfig.modelId})`);
          } else {
            console.debug(
              `[Embeddings] Error embedding batch with model '${selectedModelConfig.modelId}' via provider '${provider.providerId}': ${errorMessage}`,
            );
          }
          // Mark all texts attempted in this failed provider call as errored
          providerFetchIndexToOriginalIndexMap.forEach(originalTextIndex => {
            // Only add error if not already successfully processed (e.g., from cache)
            // and not already errored from a more specific issue like dimension mismatch
            if (finalEmbeddings[originalTextIndex]?.length === 0 && !errors.some(e => e.textIndex === originalTextIndex)) {
                 errors.push({
                    textIndex: originalTextIndex,
                    message: `Failed to generate embedding for text in batch: ${errorMessage}`,
                    details: error instanceof GMIError ? error.details : { rawError: error.toString() },
                });
            }
          });
        }
      }
    } // End batch loop

    // Filter out any positions that are still empty (null/empty array from initialization)
    // This happens if an error occurred for a text and it wasn't filled from cache or provider.
    const successfullyProcessedEmbeddings: number[][] = [];
    const finalOriginalIndices: number[] = []; // To map errors back correctly if we filter embeddings

    for(let i=0; i<finalEmbeddings.length; ++i) {
        if(finalEmbeddings[i] && finalEmbeddings[i].length > 0) {
            successfullyProcessedEmbeddings.push(finalEmbeddings[i]);
            finalOriginalIndices.push(i);
        }
    }
    
    // Adjust error indices if we are only returning successfully processed embeddings
    // This is complex if we want to maintain original indexing for errors while compacting results.
    // For now, `errors` contains original indices. `embeddings` array will correspond to `textsToEmbed`
    // with problematic ones being empty arrays IF NOT FILTERED OUT.
    // The current `EmbeddingResponse` implies `embeddings` has one entry per input text.
    // So, if an embedding failed and wasn't from cache, it should be an empty array or handled via `errors`.
    // Let's ensure `finalEmbeddings` has an entry for each input text.
    // The entries that failed (and weren't from cache) will be empty arrays.
    // The `errors` array correctly points to the original text index.

    return {
      embeddings: finalEmbeddings, // Each entry corresponds to textsToEmbed; failed ones are empty arrays.
      modelId: selectedModelConfig.modelId,
      providerId: selectedModelConfig.providerId,
      usage: {
        inputTokens: cumulativeInputTokens,
        totalTokens: cumulativeTotalTokens,
        costUSD: cumulativeCostUSD,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * @inheritdoc
   */
  public async getEmbeddingModelInfo(
    modelId?: string,
  ): Promise<EmbeddingModelConfig | undefined> {
    this.ensureInitialized();
    const idToLookup = modelId || this.defaultModel?.modelId;
    if (!idToLookup) {
        // Should not happen if initialized and defaultModel is set
        console.error("EmbeddingManager: Cannot get model info, no modelId provided and no default model set.");
        return undefined;
    }
    return this.availableModels.get(idToLookup);
  }

  /**
   * @inheritdoc
   */
  public async getEmbeddingDimension(modelId?: string): Promise<number> {
    this.ensureInitialized();
    const modelInfo = await this.getEmbeddingModelInfo(modelId); // Uses default if modelId is null

    if (modelInfo?.dimension) {
      return modelInfo.dimension;
    }
    
    // Fallback to manager's configured default dimension if model-specific is missing
    if (this.config.defaultEmbeddingDimension && this.config.defaultEmbeddingDimension > 0) {
      console.warn(`EmbeddingManager: Dimension for model '${modelId || 'default'}' not found in its config. Using system-wide default dimension: ${this.config.defaultEmbeddingDimension}.`);
      return this.config.defaultEmbeddingDimension;
    }
    
    // This case implies that the specific model (or default model if modelId was null) is missing its dimension,
    // AND no system-wide default dimension is configured. This is a critical config error.
    throw new GMIError(
      `Embedding dimension for model '${modelId || this.defaultModel?.modelId || 'unknown'}' is not configured, and no system-wide default dimension is set. Please check EmbeddingManagerConfiguration.`,
      GMIErrorCode.CONFIG_ERROR,
      { modelIdAttempted: modelId || this.defaultModel?.modelId }
    );
  }

  /**
   * @inheritdoc
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: any }> {
    if (!this.initialized || !this.defaultModel) {
      return {
        isHealthy: false,
        details: 'EmbeddingManager not initialized or no default model configured.',
      };
    }
    // Basic health check: manager is initialized, has a default model, and some models are configured.
    const isHealthy = this.availableModels.size > 0;
    let defaultProviderHealth: { isHealthy: boolean; details?: unknown } = {
      isHealthy: true,
      details: 'Default provider health not checked in this basic test.',
    };

    // Optionally, perform a lightweight check on the default model's provider
    try {
        const defaultProvider = this.providerManager.getProvider(this.defaultModel.providerId);
        if (defaultProvider && typeof defaultProvider.checkHealth === 'function') {
            defaultProviderHealth = await defaultProvider.checkHealth();
        }
    } catch (error: any) {
        defaultProviderHealth = { isHealthy: false, details: `Error checking default provider '${this.defaultModel.providerId}': ${error.message}` };
    }

    return {
      isHealthy: isHealthy && defaultProviderHealth.isHealthy,
      details: {
        managerStatus: isHealthy ? 'Initialized and Operational' : 'Issues Detected',
        configuredModels: this.availableModels.size,
        defaultModelId: this.defaultModel.modelId,
        cacheEnabled: this.cache ? true : false,
        cacheSize: this.cache ? this.cache.size : 0,
        defaultProviderStatus: defaultProviderHealth,
      },
    };
  }

  /**
   * @inheritdoc
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) {
      console.debug('EmbeddingManager: Shutdown called but not initialized. No action taken.');
      return;
    }
    (this.cache as any)?.clear?.();
    this.initialized = false;
    console.debug('EmbeddingManager shutdown complete. Cache cleared.');
  }
}
