/**
 * @fileoverview Implements the VectorStoreManager (`VectorStoreManager`), which is
 * responsible for initializing, configuring, and providing access to multiple
 * IVectorStore provider instances. It acts as a central registry and factory
 * for vector stores within the AgentOS RAG system.
 *
 * The manager uses `VectorStoreManagerConfig` to understand which providers to
 * initialize and `RagDataSourceConfig` to map logical data sources to specific
 * collections within those providers.
 *
 * @module backend/agentos/rag/VectorStoreManager
 * @see ./IVectorStoreManager.ts for the interface definition.
 * @see ./IVectorStore.ts for the underlying vector store interface.
 * @see ../config/VectorStoreConfiguration.ts for configuration structures.
 * @see ./vector_stores/InMemoryVectorStore.ts for an example provider.
 */

import {
  IVectorStoreManager,
  VectorStoreManagerHealthReport,
} from './IVectorStoreManager';
import {
  IVectorStore,
} from './IVectorStore';
import {
  VectorStoreManagerConfig,
  RagDataSourceConfig,
  AnyVectorStoreProviderConfig,
  // Import other specific store configs like PineconeVectorStoreConfig if they are directly instantiated here.
} from '../../core/config/VectorStoreConfiguration';
import { InMemoryVectorStore } from './vector_stores/InMemoryVectorStore';
import { SqlVectorStore } from './vector_stores/SqlVectorStore';
import { HnswlibVectorStore } from './vector_stores/HnswlibVectorStore';
import { QdrantVectorStore } from './vector_stores/QdrantVectorStore';
import { PineconeVectorStore } from './vector_stores/PineconeVectorStore';
// Import other IVectorStore implementations as they are created, e.g.:
// import { WeaviateVectorStore } from './vector_stores/WeaviateVectorStore';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { uuidv4 } from '../../core/utils/uuid';

/**
 * Internal structure to hold information about a configured RAG Data Source.
 * @internal
 */
interface MappedDataSourceInfo {
  dataSourceId: string;
  providerId: string;
  actualCollectionName: string;
  dimension?: number;
  // Other relevant details from RagDataSourceConfig might be stored here if needed frequently.
}

/**
 * Implements the `IVectorStoreManager` interface.
 *
 * @class VectorStoreManager
 * @implements {IVectorStoreManager}
 */
export class VectorStoreManager implements IVectorStoreManager {
  private managerConfig!: VectorStoreManagerConfig;
  private initializedProviders: Map<string, IVectorStore>; // providerId -> IVectorStore instance
  private dataSourceMappings: Map<string, MappedDataSourceInfo>; // dataSourceId -> MappedDataSourceInfo
  private isInitialized: boolean = false;
  public readonly managerInstanceId: string;

  /**
   * Constructs a VectorStoreManager instance.
   * The manager is not operational until `initialize` is called.
   */
  constructor() {
    this.initializedProviders = new Map();
    this.dataSourceMappings = new Map();
    this.managerInstanceId = `vsm-${uuidv4()}`;
  }

  /**
   * @inheritdoc
   */
  public async initialize(
    managerConfig: VectorStoreManagerConfig,
    dataSourceConfigs: RagDataSourceConfig[],
  ): Promise<void> {
    if (this.isInitialized) {
      console.warn(`VectorStoreManager (ID: ${this.managerInstanceId}) already initialized. Re-initializing. Existing providers and mappings will be cleared.`);
      await this.shutdownAllProviders(); // Gracefully shutdown existing before re-init
      this.initializedProviders.clear();
      this.dataSourceMappings.clear();
    }

    if (!managerConfig) {
        throw new GMIError('VectorStoreManagerConfig cannot be null or undefined.', GMIErrorCode.CONFIG_ERROR);
    }
    if (!dataSourceConfigs) {
        throw new GMIError('DataSourceConfigs array cannot be null or undefined.', GMIErrorCode.CONFIG_ERROR);
    }

    this.managerConfig = managerConfig;

    if (!this.managerConfig.providers || this.managerConfig.providers.length === 0) {
      console.warn(`VectorStoreManager (ID: ${this.managerInstanceId}): No vector store providers configured. The manager will be initialized but unable to serve stores.`);
      // Depending on strictness, might throw an error if at least one provider is expected.
    }

    // Initialize providers
    for (const providerConfig of this.managerConfig.providers) {
      if (!providerConfig.id || !providerConfig.type) {
        console.error(`VectorStoreManager (ID: ${this.managerInstanceId}): Provider config is missing 'id' or 'type'. Skipping.`, providerConfig);
        continue;
      }
      try {
        const storeInstance = this.createProviderInstance(providerConfig);
        await storeInstance.initialize(providerConfig);
        this.initializedProviders.set(providerConfig.id, storeInstance);
        console.log(`VectorStoreManager (ID: ${this.managerInstanceId}): Successfully initialized provider '${providerConfig.id}' of type '${providerConfig.type}'.`);
      } catch (error: any) {
        console.error(`VectorStoreManager (ID: ${this.managerInstanceId}): Failed to initialize provider '${providerConfig.id}'. Error: ${error.message}`, error);
        // Decide on error handling: throw, or continue initializing other providers?
        // For now, log error and continue; health checks can reveal issues.
        // If this provider was the default, it could be problematic.
        if (this.managerConfig.defaultProviderId === providerConfig.id) {
            throw new GMIError(`Failed to initialize the default provider '${providerConfig.id}'. Cannot continue.`, GMIErrorCode.INITIALIZATION_FAILED, { providerId: providerConfig.id, underlyingError: error });
        }
      }
    }

    // Process and map data sources
    for (const dsConfig of dataSourceConfigs) {
      if (!this.initializedProviders.has(dsConfig.vectorStoreProviderId)) {
        console.warn(`VectorStoreManager (ID: ${this.managerInstanceId}): Data source '${dsConfig.dataSourceId}' references an uninitialized or missing provider '${dsConfig.vectorStoreProviderId}'. Skipping this data source mapping.`);
        continue;
      }
      this.dataSourceMappings.set(dsConfig.dataSourceId, {
        dataSourceId: dsConfig.dataSourceId,
        providerId: dsConfig.vectorStoreProviderId,
        actualCollectionName: dsConfig.actualNameInProvider,
        dimension: dsConfig.embeddingDimension || this.managerConfig.defaultEmbeddingDimension,
      });
    }

    // Validate defaultProviderId if set
    if (this.managerConfig.defaultProviderId && !this.initializedProviders.has(this.managerConfig.defaultProviderId)) {
        throw new GMIError(`VectorStoreManagerConfig: Specified defaultProviderId '${this.managerConfig.defaultProviderId}' does not match any successfully initialized provider.`, GMIErrorCode.CONFIG_ERROR, { defaultProviderId: this.managerConfig.defaultProviderId });
    }


    this.isInitialized = true;
    console.log(`VectorStoreManager (ID: ${this.managerInstanceId}) initialized successfully with ${this.initializedProviders.size} provider(s) and ${this.dataSourceMappings.size} data source mapping(s).`);
  }

  /**
   * Ensures that the manager has been initialized.
   * @private
   * @throws {GMIError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        `VectorStoreManager (ID: ${this.managerInstanceId}) is not initialized. Call initialize() first.`,
        GMIErrorCode.NOT_INITIALIZED,
      );
    }
  }

  /**
   * Creates an instance of an IVectorStore provider based on its configuration.
   * This method acts as a factory for vector store implementations.
   *
   * @private
   * @param {AnyVectorStoreProviderConfig} providerConfig - The configuration for the provider.
   * @returns {IVectorStore} An instance of the IVectorStore implementation.
   * @throws {GMIError} If the provider type is unknown or unsupported.
   */
  private createProviderInstance(providerConfig: AnyVectorStoreProviderConfig): IVectorStore {
    switch (providerConfig.type) {
      case 'in_memory':
        // Type assertion is safe here due to the 'type' discriminant.
        return new InMemoryVectorStore();
      case 'pinecone':
        return new PineconeVectorStore(providerConfig as Extract<AnyVectorStoreProviderConfig, { type: 'pinecone' }>);
      case 'sql':
        // SQL-backed vector store using @framers/sql-storage-adapter
        // Supports SQLite, PostgreSQL, IndexedDB, and more
        return new SqlVectorStore();
      case 'hnswlib':
        // DEPRECATED: Use SqlVectorStore (type: 'sql') instead — it now includes
        // automatic HNSW acceleration via HnswIndexSidecar.
        console.warn(
          '[DEPRECATED] VectorStore type "hnswlib" is deprecated. Use type "sql" instead — ' +
          'SqlVectorStore now includes automatic HNSW acceleration.',
        );
        return new HnswlibVectorStore();
      case 'qdrant':
        // Qdrant vector store via HTTP (self-hosted or cloud)
        return new QdrantVectorStore();
      case 'neo4j': {
        // Neo4j vector store via native vector indexes (requires neo4j-driver)
        // Dynamic import to keep neo4j-driver optional
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Neo4jVectorStore } = require('./vector_stores/Neo4jVectorStore');
        return new Neo4jVectorStore();
      }
      default:
        throw new GMIError(
          `Unsupported vector store provider type: '${providerConfig.type}' for provider ID '${providerConfig.id}'.`,
          GMIErrorCode.NOT_SUPPORTED,
          { providerType: providerConfig.type, providerId: providerConfig.id }
        );
    }
  }

  /**
   * @inheritdoc
   */
  public getProvider(providerId: string): IVectorStore {
    this.ensureInitialized();
    const provider = this.initializedProviders.get(providerId);
    if (!provider) {
      throw new GMIError(
        `Vector store provider with ID '${providerId}' not found or not initialized in VectorStoreManager (ID: ${this.managerInstanceId}).`,
        GMIErrorCode.NOT_FOUND,
        { providerId }
      );
    }
    return provider;
  }

  /**
   * @inheritdoc
   */
  public getDefaultProvider(): IVectorStore {
    this.ensureInitialized();
    const defaultProviderId = this.managerConfig.defaultProviderId;
    if (!defaultProviderId) {
      // If no default is explicitly set, and there's only one provider, make it the default.
      if (this.initializedProviders.size === 1) {
        const iterator = this.initializedProviders.values().next();
        if (!iterator.done && iterator.value) {
          return iterator.value;
        }
      }
      throw new GMIError(
        `No default vector store provider ID configured in VectorStoreManager (ID: ${this.managerInstanceId}).`,
        GMIErrorCode.CONFIG_ERROR,
      );
    }
    return this.getProvider(defaultProviderId);
  }

  /**
   * @inheritdoc
   */
  public async getStoreForDataSource(
    dataSourceId: string,
  ): Promise<{ store: IVectorStore; collectionName: string; dimension?: number }> {
    this.ensureInitialized();
    const mappingInfo = this.dataSourceMappings.get(dataSourceId);
    if (!mappingInfo) {
      throw new GMIError(
        `Data source mapping for ID '${dataSourceId}' not found in VectorStoreManager (ID: ${this.managerInstanceId}).`,
        GMIErrorCode.NOT_FOUND,
        { dataSourceId }
      );
    }

    const store = this.getProvider(mappingInfo.providerId); // This will throw if provider not found/initialized
    return {
      store,
      collectionName: mappingInfo.actualCollectionName,
      dimension: mappingInfo.dimension,
    };
  }

  /**
   * @inheritdoc
   */
  public listProviderIds(): string[] {
    this.ensureInitialized();
    return Array.from(this.initializedProviders.keys());
  }

  /**
   * @inheritdoc
   */
  public listDataSourceIds(): string[] {
    this.ensureInitialized();
    return Array.from(this.dataSourceMappings.keys());
  }

  /**
   * @inheritdoc
   */
  public async checkHealth(providerId?: string): Promise<VectorStoreManagerHealthReport> {
    this.ensureInitialized();
    const report: VectorStoreManagerHealthReport = {
      isOverallHealthy: true, // Assume healthy unless a provider fails
      providerStatus: {},
      managerDetails: {
        managerId: this.managerInstanceId,
        initializedProvidersCount: this.initializedProviders.size,
        mappedDataSourcesCount: this.dataSourceMappings.size,
        defaultProviderId: this.managerConfig.defaultProviderId || (this.initializedProviders.size === 1 ? this.initializedProviders.keys().next().value : 'Not Set'),
      },
    };

    const providersToCheck = providerId
      ? [this.getProvider(providerId)] // Will throw if providerId is invalid
      : Array.from(this.initializedProviders.values());
    
    const providerIdMap = new Map<IVectorStore, string>();
    this.initializedProviders.forEach((store, id) => providerIdMap.set(store, id));


    for (const provider of providersToCheck) {
      const currentProviderId = providerId || providerIdMap.get(provider) || 'unknown'; // Find ID for multi-provider check
      try {
        const health = await provider.checkHealth();
        if (report.providerStatus) {
             report.providerStatus[currentProviderId] = health;
        }
        if (!health.isHealthy) {
          report.isOverallHealthy = false;
        }
      } catch (error: any) {
        if (report.providerStatus) {
            report.providerStatus[currentProviderId] = {
                isHealthy: false,
                details: `Error checking health: ${error.message}`,
            };
        }
        report.isOverallHealthy = false;
      }
    }
     if (providerId && providersToCheck.length === 1 && report.providerStatus && report.providerStatus[providerId]) {
        // If checking a single provider, overall health is that provider's health.
        report.isOverallHealthy = report.providerStatus[providerId].isHealthy;
    } else if (this.initializedProviders.size === 0 && !this.managerConfig.providers?.length) {
        // If no providers configured and none initialized, manager might be "healthy" but useless.
        // Let's say it's not healthy if it can't do anything.
        // This depends on application requirements. For now, if no providers, overall health false.
        if (this.managerConfig.providers?.length === 0) {
            report.isOverallHealthy = false;
            if(report.managerDetails) report.managerDetails.statusMessage = "No providers configured.";
        }
    }


    return report;
  }

  /**
   * @inheritdoc
   */
  public async shutdownAllProviders(): Promise<void> {
    if (!this.isInitialized) {
        console.log(`VectorStoreManager (ID: ${this.managerInstanceId}): Shutdown called but not initialized.`);
        return;
    }
    console.log(`VectorStoreManager (ID: ${this.managerInstanceId}): Shutting down all initialized providers...`);
    for (const [providerId, provider] of this.initializedProviders) {
      try {
        await provider.shutdown();
        console.log(`VectorStoreManager (ID: ${this.managerInstanceId}): Provider '${providerId}' shut down successfully.`);
      } catch (error: any) {
        console.error(`VectorStoreManager (ID: ${this.managerInstanceId}): Error shutting down provider '${providerId}'. Error: ${error.message}`, error);
      }
    }
    this.initializedProviders.clear();
    this.dataSourceMappings.clear();
    this.isInitialized = false; // Mark as fully shut down
    console.log(`VectorStoreManager (ID: ${this.managerInstanceId}): All providers shut down and manager state cleared.`);
  }
}
