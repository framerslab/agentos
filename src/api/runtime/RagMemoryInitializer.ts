/**
 * @file RagMemoryInitializer.ts
 * @module api/RagMemoryInitializer
 *
 * @description
 * Encapsulates the initialization and lifecycle of the RAG (Retrieval
 * Augmented Generation) subsystem and standalone-memory integration,
 * previously spread across four private methods inside `AgentOS.ts`:
 *
 * - `resolveStandaloneMemoryConfig()` -- derive memoryTools, long-term
 *   retriever, and rolling-summary sink from a unified `Memory` backend.
 * - `configureManagedStandaloneMemory()` -- register lifecycle closers.
 * - `registerConfigMemoryTools()` -- load memory tools as an extension pack.
 * - `initializeRagSubsystem()` -- bootstrap EmbeddingManager,
 *   VectorStoreManager, and RetrievalAugmentor.
 *
 * AgentOS replaces its old `this.retrievalAugmentor`,
 * `this.ragVectorStoreManager`, `this.manageRetrievalAugmentorLifecycle`,
 * and `this.managedStandaloneMemoryClosers` fields with a single
 * `RagMemoryInitializer` instance and accesses values through public
 * read-only accessors.
 */

import type { ILogger } from '../../core/logging/ILogger';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import type { IRetrievalAugmentor } from '../../cognition/rag/IRetrievalAugmentor';
import type { IVectorStoreManager } from '../../core/vector-store/IVectorStoreManager';
import type { VectorStoreManagerConfig } from '../../core/config/VectorStoreConfiguration';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type {
  ExtensionManager,
  ExtensionLifecycleContext,
} from '../extensions';
import { createMemoryToolsPack } from '../../cognition/memory/io/extension/MemoryToolsExtension.js';
import type { Memory } from '../../cognition/memory/io/facade/Memory.js';
import {
  createStandaloneMemoryLongTermRetriever,
  createStandaloneMemoryRollingSummarySink,
} from '../../cognition/memory/io/integration/StandaloneMemoryBridge.js';
import type {
  StandaloneMemoryLongTermRetrieverOptions,
  StandaloneMemoryRollingSummarySinkOptions,
} from '../../cognition/memory/io/integration/StandaloneMemoryBridge.js';

import type {
  AgentOSConfig,
  AgentOSMemoryToolsConfig,
} from './AgentOS';

/**
 * Dependencies injected into the initializer at construction time.
 */
export interface RagMemoryInitializerDependencies {
  /** Extension manager for loading memory tool packs. */
  extensionManager: ExtensionManager;
  /** Model provider manager used by the RAG embedding manager. */
  modelProviderManager: AIModelProviderManager;
  /** Logger scoped to this subsystem. */
  logger: ILogger;
}

/**
 * @class RagMemoryInitializer
 *
 * Bootstraps standalone memory integration and the RAG subsystem.
 * Extracted from `AgentOS` to reduce monolith complexity.
 */
export class RagMemoryInitializer {
  private _retrievalAugmentor?: IRetrievalAugmentor;
  private _vectorStoreManager?: IVectorStoreManager;
  private _manageLifecycle: boolean = false;
  private _managedStandaloneMemoryClosers: Array<() => Promise<void>> = [];

  constructor(private readonly deps: RagMemoryInitializerDependencies) {}

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * The retrieval augmentor, available after {@link initializeRag} completes.
   * May be `undefined` if RAG is not configured or initialization failed.
   */
  public get retrievalAugmentor(): IRetrievalAugmentor | undefined {
    return this._retrievalAugmentor;
  }

  /**
   * The vector store manager, available after {@link initializeRag} completes.
   * May be `undefined` if RAG is not configured.
   */
  public get vectorStoreManager(): IVectorStoreManager | undefined {
    return this._vectorStoreManager;
  }

  // ---------------------------------------------------------------------------
  // Standalone memory config resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a standalone memory configuration into derived config fields:
   * memoryTools, longTermMemoryRetriever, rollingSummaryMemorySink.
   *
   * This is a pure transformation that does not mutate any instance state.
   * Static because it is called before the initializer's dependencies are
   * fully wired.
   *
   * @param config - The raw AgentOS configuration.
   * @returns A shallow copy of the config with derived fields populated.
   */
  public static resolveConfig(config: AgentOSConfig): AgentOSConfig {
    const standalone = config.standaloneMemory;
    if (!standalone || standalone.enabled === false) {
      return { ...config };
    }

    const resolved: AgentOSConfig = { ...config };
    const memory = standalone.memory;

    if (!resolved.memoryTools && standalone.tools) {
      resolved.memoryTools = {
        memory: memory as Pick<Memory, 'createTools'> & Partial<Pick<Memory, 'close'>>,
        ...(standalone.tools === true ? {} : standalone.tools),
      };
    }

    if (!resolved.longTermMemoryRetriever && standalone.longTermRetriever) {
      resolved.longTermMemoryRetriever = createStandaloneMemoryLongTermRetriever(
        memory as unknown as Pick<Memory, 'recall' | 'feedbackFromResponse'>,
        standalone.longTermRetriever === true ? undefined : standalone.longTermRetriever,
      );
    }

    if (!resolved.rollingSummaryMemorySink && standalone.rollingSummarySink) {
      resolved.rollingSummaryMemorySink = createStandaloneMemoryRollingSummarySink(
        memory as Pick<Memory, 'remember' | 'recall' | 'forget'> &
          Partial<Pick<Memory, 'health' | 'close'>>,
        standalone.rollingSummarySink === true ? undefined : standalone.rollingSummarySink,
      );
    }

    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Managed standalone memory lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Register lifecycle closers for standalone memory backends that AgentOS
   * should shut down. Must be called after the frozen config is set.
   *
   * @param config - The frozen AgentOS config (post-resolve).
   */
  public configureManaged(config: Readonly<AgentOSConfig>): void {
    this._managedStandaloneMemoryClosers = [];

    const standalone = config.standaloneMemory;
    if (!standalone || standalone.enabled === false || standalone.manageLifecycle !== true) {
      return;
    }
    if (config.memoryTools?.manageLifecycle === true) {
      return;
    }
    if (typeof standalone.memory.close !== 'function') {
      return;
    }

    this._managedStandaloneMemoryClosers.push(async () => {
      await standalone.memory.close?.();
    });
  }

  // ---------------------------------------------------------------------------
  // Memory tools registration
  // ---------------------------------------------------------------------------

  /**
   * Load configured memory tools as an extension pack. Where the runtime has a learning layer the pack leaves
   * `memory_reflect` out: it consolidates across every scope of the Brain, a change no learner owns, and the host
   * consolidates through `Memory.consolidate()` instead. A host that asked for it (`includeReflect: true`) is told
   * once, at registration.
   *
   * @param memoryToolsConfig     - The memory tools config block from AgentOSConfig.
   * @param context               - Extension lifecycle context.
   * @param options.learningLayer - Whether the runtime has a learning layer, built or passed.
   */
  public async registerMemoryTools(
    memoryToolsConfig: AgentOSMemoryToolsConfig | undefined,
    context: ExtensionLifecycleContext,
    options: { learningLayer?: boolean } = {},
  ): Promise<void> {
    if (!memoryToolsConfig || memoryToolsConfig.enabled === false) {
      return;
    }

    const {
      memory,
      enabled: _enabled,
      identifier,
      manageLifecycle,
      ...packOptions
    } = memoryToolsConfig;

    if (options.learningLayer && packOptions.includeReflect === true) {
      this.deps.logger.warn(
        '[AgentOS] memory_reflect is withdrawn where a learning layer runs; the memory tools pack leaves it out (consolidate with Memory.consolidate()).',
      );
    }
    const pack = createMemoryToolsPack(memory, options.learningLayer ? { ...packOptions, includeReflect: false } : packOptions);
    const packIdentifier = identifier ?? 'config-memory-tools';
    if (manageLifecycle) {
      const existingOnDeactivate = pack.onDeactivate;
      pack.onDeactivate = async (lifecycleContext) => {
        await existingOnDeactivate?.(lifecycleContext);
        await memory.close?.();
      };
    }

    await this.deps.extensionManager.loadPackFromFactory(
      pack,
      packIdentifier,
      undefined,
      context,
    );

    this.deps.logger.info('[AgentOS] Config memory tools enabled', {
      identifier: packIdentifier,
      packName: pack.name,
      toolCount: pack.descriptors.length,
      ...(options.learningLayer ? { memoryReflect: 'withdrawn' } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // RAG subsystem
  // ---------------------------------------------------------------------------

  /**
   * Bootstrap the RAG subsystem: embedding manager, vector store manager,
   * and retrieval augmentor. If a caller-provided augmentor is present in
   * the config, it is used directly.
   *
   * @param config         - The frozen AgentOS config.
   * @param storageAdapter - Optional storage adapter for SQL vector stores.
   */
  public async initializeRag(
    config: Readonly<AgentOSConfig>,
    storageAdapter?: StorageAdapter,
  ): Promise<void> {
    // Prefer caller-provided augmentor instance.
    if (config.retrievalAugmentor) {
      this._retrievalAugmentor = config.retrievalAugmentor;
      this._manageLifecycle = config.manageRetrievalAugmentorLifecycle === true;
      return;
    }

    const ragConfig = config.ragConfig;
    if (!ragConfig || ragConfig.enabled === false) {
      return;
    }

    try {
      const { EmbeddingManager } = await import('../rag/EmbeddingManager');
      const { VectorStoreManager } = await import('../rag/VectorStoreManager');
      const { RetrievalAugmentor } = await import('../rag/RetrievalAugmentor');

      const embeddingManager = new EmbeddingManager();
      await embeddingManager.initialize(
        ragConfig.embeddingManagerConfig,
        this.deps.modelProviderManager,
      );

      const bindToStorageAdapter =
        ragConfig.bindToStorageAdapter === undefined
          ? true
          : ragConfig.bindToStorageAdapter === true;

      const patchedVectorStoreConfig: VectorStoreManagerConfig = {
        ...ragConfig.vectorStoreManagerConfig,
        providers: ragConfig.vectorStoreManagerConfig.providers.map((provider) => {
          if (
            bindToStorageAdapter &&
            storageAdapter &&
            (provider as any)?.type === 'sql' &&
            !(provider as any).adapter &&
            !(provider as any).storage
          ) {
            return { ...(provider as any), adapter: storageAdapter };
          }
          return provider;
        }),
      };

      const vectorStoreManager = new VectorStoreManager();
      await vectorStoreManager.initialize(
        patchedVectorStoreConfig,
        ragConfig.dataSourceConfigs,
      );

      const retrievalAugmentor = new RetrievalAugmentor();
      await retrievalAugmentor.initialize(
        ragConfig.retrievalAugmentorConfig,
        embeddingManager,
        vectorStoreManager,
      );

      this._retrievalAugmentor = retrievalAugmentor;
      this._vectorStoreManager = vectorStoreManager;
      this._manageLifecycle = ragConfig.manageLifecycle !== false;
      console.log('AgentOS: RAG subsystem initialized.');
    } catch (error: any) {
      this.deps.logger.error(
        'AgentOS: Failed to initialize RAG subsystem; continuing without retrieval augmentor.',
        {
          error: error?.message ?? error,
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shut down owned RAG resources and managed standalone memory
   * backends.
   */
  public async shutdown(): Promise<void> {
    if (this._manageLifecycle && this._retrievalAugmentor?.shutdown) {
      await this._retrievalAugmentor.shutdown();
      console.log('AgentOS: RetrievalAugmentor shut down.');
    }
    if (this._manageLifecycle && this._vectorStoreManager?.shutdownAllProviders) {
      await this._vectorStoreManager.shutdownAllProviders();
      console.log('AgentOS: VectorStore providers shut down.');
    }
    for (const closeMemory of this._managedStandaloneMemoryClosers) {
      await closeMemory();
    }
    this._managedStandaloneMemoryClosers = [];
  }
}
