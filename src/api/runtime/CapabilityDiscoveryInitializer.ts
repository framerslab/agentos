/**
 * @file CapabilityDiscoveryInitializer.ts
 * @module api/CapabilityDiscoveryInitializer
 *
 * @description
 * Encapsulates the bootstrapping of the capability discovery subsystem and
 * turn planner, previously inlined in `AgentOS.initialize()`. This includes:
 *
 * - Creating and configuring the `EmbeddingManager` dedicated to discovery.
 * - Creating an `InMemoryVectorStore` for capability embeddings.
 * - Initializing the `CapabilityDiscoveryEngine` with sources derived from
 *   the active tool, extension, workflow, and messaging registries.
 * - Registering the discovery meta-tools.
 * - Creating the `AgentOSTurnPlanner`.
 *
 * AgentOS replaces its old `this.turnPlanner`, `this.capabilityDiscoveryEngine`,
 * `this.discoveryEmbeddingManager`, and `this.discoveryVectorStore` fields
 * with a single `CapabilityDiscoveryInitializer` instance and accesses values
 * through public read-only accessors.
 */

import type { ILogger } from '../../core/logging/ILogger';
import { createRequire } from 'node:module';
import type { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import type { ITool } from '../../core/tools/ITool';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import {
  type ExtensionManager,
  EXTENSION_KIND_TOOL,
  EXTENSION_KIND_WORKFLOW,
  EXTENSION_KIND_MESSAGING_CHANNEL,
} from '../extensions';
import type { MessagingChannelPayload } from '../../extensions/MessagingChannelPayload';
import {
  AgentOSTurnPlanner,
  type ITurnPlanner,
} from '../../orchestration/turn-planner/TurnPlanner';
import {
  CapabilityDiscoveryEngine,
  createDiscoverCapabilitiesTool,
  createLoadCapabilityExtensionTool,
} from '../discovery';
import type {
  CapabilityDescriptor,
  CapabilityIndexSources,
  ICapabilityDiscoveryEngine,
} from '../../cognition/discovery/types';
import { EmbeddingManager } from '../../cognition/rag/EmbeddingManager';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import type { WorkflowDescriptorPayload } from '../../orchestration/workflows/WorkflowTypes';

import type {
  AgentOSTurnPlanningConfig,
  AgentOSCapabilityDiscoverySources,
} from './AgentOS';
import { adaptTools } from './toolAdapter';
import type { AdaptableToolInput } from './toolAdapter';
import type { AIModelProviderManagerConfig } from '../../core/llm/providers/AIModelProviderManager';

/** Provider-keyed defaults for discovery embedding model and dimension. */
const DISCOVERY_EMBEDDING_DEFAULTS: Record<string, { modelId: string; dimension: number }> = {
  openai: { modelId: 'text-embedding-3-small', dimension: 1536 },
  openrouter: { modelId: 'openai/text-embedding-3-small', dimension: 1536 },
  ollama: { modelId: 'nomic-embed-text', dimension: 768 },
};

const require = createRequire(import.meta.url);

type CuratedRegistryEntry = {
  name: string;
  packageName: string;
  category?: string;
  displayName?: string;
  description?: string;
  requiredSecrets?: string[];
  available?: boolean;
};

type CuratedManifest = {
  description?: string;
  categories?: string[];
  keywords?: string[];
  extensions?: Array<{
    kind?: string;
    id?: string;
    displayName?: string;
    description?: string;
  }>;
};

let curatedManifestDescriptorCache: Promise<CapabilityDescriptor[]> | undefined;

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function loadCuratedManifestDescriptors(
  logger?: Pick<ILogger, 'warn'>,
): Promise<CapabilityDescriptor[]> {
  if (!curatedManifestDescriptorCache) {
    curatedManifestDescriptorCache = (async () => {
      try {
        const registry = await import('@framers/agentos-extensions-registry');
        const catalog = Array.isArray((registry as any).TOOL_CATALOG)
          ? ((registry as any).TOOL_CATALOG as CuratedRegistryEntry[] ?? [])
          : [];
        const descriptors: CapabilityDescriptor[] = [];

        for (const entry of catalog) {
          if (typeof entry.packageName !== 'string' || !entry.packageName.trim()) {
            continue;
          }

          let manifest: CuratedManifest | null = null;
          try {
            manifest = require(`${entry.packageName}/manifest.json`) as CuratedManifest;
          } catch {
            continue;
          }

          const extensions = Array.isArray(manifest.extensions) ? manifest.extensions : [];
          for (const extension of extensions) {
            if (extension?.kind !== 'tool' || typeof extension.id !== 'string' || !extension.id.trim()) {
              continue;
            }

            const tags = Array.from(
              new Set([
                ...(Array.isArray(manifest.keywords) ? manifest.keywords : []),
                ...(Array.isArray(manifest.categories) ? manifest.categories : []),
              ].filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)),
            );

            descriptors.push({
              id: `tool:${extension.id}`,
              kind: 'tool',
              name: extension.id,
              displayName: extension.displayName || titleCase(extension.id),
              description: extension.description || entry.description || manifest.description || '',
              category:
                (Array.isArray(manifest.categories) && manifest.categories[0]) ||
                entry.category ||
                'general',
              tags,
              requiredSecrets: Array.isArray(entry.requiredSecrets) ? entry.requiredSecrets : [],
              requiredTools: [],
              available: entry.available !== false,
              sourceRef: {
                type: 'extension',
                packageName: entry.name,
                extensionId: entry.name,
              },
            });
          }
        }

        return descriptors;
      } catch (error) {
        logger?.warn?.('Capability discovery could not load curated registry manifests', {
          error,
        });
        return [];
      }
    })();
  }

  return curatedManifestDescriptorCache;
}

/**
 * The curated registry's descriptors that may sit in the index beside the host's own sources.
 *
 * The index keeps one descriptor per id, the later one winning, and a curated descriptor says what the catalog says:
 * `available: false` for the packs it lists as needing setup, and no input schema. So a curated descriptor whose id the
 * host already holds (a tool it has loaded, which the index names `tool:<name>`, or one of its own manifests) is left
 * out, and the tool keeps its own descriptor: available, with its input schema, among the capabilities the turn
 * planner asks for. A pack the catalog lists under several entries brings its manifest's tools once per entry; each id
 * is kept once.
 *
 * @param curated - Descriptors read from the curated packs' manifests, in catalog order.
 * @param host - The host's own tools and manifests, as the index sources hold them.
 * @returns The curated descriptors no host source holds, each id once, in their first order.
 */
export function curatedDescriptorsBeside(
  curated: readonly CapabilityDescriptor[],
  host: Pick<CapabilityIndexSources, 'tools' | 'manifests'>,
): CapabilityDescriptor[] {
  const taken = new Set<string>([
    ...(host.tools ?? []).map((tool) => `tool:${tool.name}`),
    ...(host.manifests ?? []).map((descriptor) => descriptor.id),
  ]);
  const kept: CapabilityDescriptor[] = [];
  for (const descriptor of curated) {
    if (taken.has(descriptor.id)) continue;
    taken.add(descriptor.id);
    kept.push(descriptor);
  }
  return kept;
}

/**
 * Dependencies injected into the initializer at construction time.
 */
export interface CapabilityDiscoveryInitializerDependencies {
  /** Tool orchestrator for meta-tool registration and tool listing. */
  toolOrchestrator: IToolOrchestrator;
  /** Extension manager providing access to tool/workflow/channel registries. */
  extensionManager: ExtensionManager;
  /** Model provider manager used to derive embedding provider and create embedding manager. */
  modelProviderManager: AIModelProviderManager;
  /** Model provider manager configuration for provider ID fallback lookup. */
  modelProviderManagerConfig: AIModelProviderManagerConfig;
  /** Turn planning configuration (may be undefined if feature is disabled). */
  turnPlanningConfig?: AgentOSTurnPlanningConfig;
  /** Normalized config-level tool input for index source building. */
  configTools?: AdaptableToolInput;
  /** Logger scoped to this subsystem. */
  logger: ILogger;
}

/**
 * @class CapabilityDiscoveryInitializer
 *
 * Bootstraps the capability discovery engine and turn planner subsystem.
 * Extracted from `AgentOS` to reduce monolith complexity.
 */
export class CapabilityDiscoveryInitializer {
  private _turnPlanner?: ITurnPlanner;
  private _discoveryEngine?: ICapabilityDiscoveryEngine;
  private _embeddingManager?: EmbeddingManager;
  private _vectorStore?: InMemoryVectorStore;

  constructor(private readonly deps: CapabilityDiscoveryInitializerDependencies) {}

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * The turn planner instance. Available after {@link initialize} completes.
   * May be `undefined` if turn planning is disabled.
   */
  public get turnPlanner(): ITurnPlanner | undefined {
    return this._turnPlanner;
  }

  /**
   * The capability discovery engine. Available after {@link initialize} completes.
   * May be `undefined` if discovery is disabled or initialization failed gracefully.
   */
  public get discoveryEngine(): ICapabilityDiscoveryEngine | undefined {
    return this._discoveryEngine;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Run the full bootstrapping sequence:
   * 1. Optionally create the capability discovery engine.
   * 2. Create the turn planner with the discovery engine (if available).
   * 3. Register the `discover_capabilities` meta-tool when configured.
   */
  public async initialize(): Promise<void> {
    const turnPlanningConfig = this.deps.turnPlanningConfig;
    if (turnPlanningConfig?.enabled === false) {
      this._turnPlanner = undefined;
      this._discoveryEngine = undefined;
      return;
    }

    let discoveryEngine: ICapabilityDiscoveryEngine | undefined =
      turnPlanningConfig?.discovery?.engine;

    if (!discoveryEngine && turnPlanningConfig?.discovery?.enabled !== false) {
      try {
        discoveryEngine = await this.initializeCapabilityDiscoveryEngine(
          turnPlanningConfig ?? {},
        );
      } catch (error: any) {
        this.deps.logger.warn(
          'Capability discovery initialization failed; planner will continue without discovery',
          {
            error: error?.message ?? error,
          },
        );
      }
    }

    this._turnPlanner = new AgentOSTurnPlanner(
      turnPlanningConfig,
      discoveryEngine,
      this.deps.logger.child?.({ component: 'TurnPlanner' }) ?? this.deps.logger,
    );
    this._discoveryEngine = discoveryEngine;
    this.deps.logger.info('AgentOS turn planner initialized', {
      discoveryEnabled: Boolean(discoveryEngine?.isInitialized?.()),
      defaultToolFailureMode: turnPlanningConfig?.defaultToolFailureMode ?? 'fail_open',
      defaultToolSelectionMode:
        turnPlanningConfig?.discovery?.defaultToolSelectionMode ?? 'discovered',
    });
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Clean up owned resources: vector store, embedding manager, and
   * null out planner/engine references.
   */
  public async shutdown(): Promise<void> {
    if (this._vectorStore?.shutdown) {
      await this._vectorStore.shutdown();
      this._vectorStore = undefined;
    }
    if (this._embeddingManager?.shutdown) {
      await this._embeddingManager.shutdown();
      this._embeddingManager = undefined;
    }
    this._turnPlanner = undefined;
    this._discoveryEngine = undefined;
  }

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  /**
   * The index sources the discovery engine starts from: the host's own (its loaded tools, packs, workflows, channels
   * and configured sources), then the curated registry's descriptors that no host source already holds.
   *
   * @param overrides - Sources the host configured for discovery, merged as `buildCapabilityIndexSources` merges them.
   * @param curated - Descriptors read from the curated packs' manifests.
   * @returns Sources in which a tool the host has loaded keeps its own descriptor and each curated id appears once.
   */
  public indexSourcesWithCurated(
    overrides: AgentOSCapabilityDiscoverySources | undefined,
    curated: readonly CapabilityDescriptor[],
  ): CapabilityIndexSources {
    const sources = this.buildCapabilityIndexSources(overrides);
    return {
      ...sources,
      manifests: [...(sources.manifests ?? []), ...curatedDescriptorsBeside(curated, sources)],
    };
  }

  /**
   * Build capability index sources from the active runtime registries.
   *
   * @param overrides - Optional explicit sources to merge with runtime-derived data.
   * @returns Aggregated sources suitable for `CapabilityDiscoveryEngine.initialize()`.
   */
  public buildCapabilityIndexSources(
    overrides?: AgentOSCapabilityDiscoverySources,
  ): CapabilityIndexSources {
    const toolRegistry = this.deps.extensionManager.getRegistry<ITool>(EXTENSION_KIND_TOOL);
    const runtimeTools = new Map<string, ITool>();
    for (const tool of toolRegistry
      .listActive()
      .map((descriptor) => descriptor.payload)
      .filter(Boolean)) {
      runtimeTools.set(tool.name, tool);
    }
    for (const tool of adaptTools(this.deps.configTools)) {
      runtimeTools.set(tool.name, tool);
    }
    const tools: NonNullable<CapabilityIndexSources['tools']> = Array.from(
      runtimeTools.values(),
    ).map((tool) => ({
      id: tool.id || `tool:${tool.name}`,
      name: tool.name,
      displayName: tool.displayName || titleCase(tool.name),
      description: tool.description || '',
      category: tool.category || 'general',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      requiredCapabilities: tool.requiredCapabilities,
      hasSideEffects: tool.hasSideEffects,
    }));

    const loadedPacks = this.deps.extensionManager.listLoadedPacks();
    const packExtensions: NonNullable<CapabilityIndexSources['extensions']> = loadedPacks.map(
      (pack) => ({
        id: `extension:${pack.key}`,
        name: pack.name,
        displayName: titleCase(pack.name),
        description: `Extension pack${pack.version ? ` v${pack.version}` : ''}`,
        category: 'extensions',
        available: true,
      }),
    );

    const workflowRegistry =
      this.deps.extensionManager.getRegistry<WorkflowDescriptorPayload>(EXTENSION_KIND_WORKFLOW);
    const workflowExtensions: NonNullable<CapabilityIndexSources['extensions']> = workflowRegistry
      .listActive()
      .map((descriptor) => ({
        id: `workflow:${descriptor.payload.definition.id}`,
        name: descriptor.payload.definition.id,
        displayName:
          descriptor.payload.definition.displayName ||
          titleCase(descriptor.payload.definition.id),
        description:
          descriptor.payload.definition.description || 'Workflow automation capability',
        category: 'workflow',
        requiredSecrets: descriptor.payload.definition.metadata?.requiredSecrets,
        available: true,
      }));

    const messagingRegistry = this.deps.extensionManager.getRegistry<MessagingChannelPayload>(
      EXTENSION_KIND_MESSAGING_CHANNEL,
    );
    const channels: NonNullable<CapabilityIndexSources['channels']> = messagingRegistry
      .listActive()
      .map((descriptor) => descriptor.payload)
      .filter(Boolean)
      .map((channel) => ({
        platform: channel.platform,
        displayName: channel.displayName || titleCase(channel.platform),
        description: `${channel.displayName || titleCase(channel.platform)} messaging channel`,
        capabilities: Array.isArray(channel.capabilities)
          ? channel.capabilities.map((cap) => String(cap))
          : [],
      }));

    return {
      tools,
      extensions: [...packExtensions, ...workflowExtensions, ...(overrides?.extensions ?? [])],
      channels: [...channels, ...(overrides?.channels ?? [])],
      skills: overrides?.skills,
      manifests: overrides?.manifests,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Initialize the capability discovery engine: embedding manager, vector
   * store, discovery engine, and optionally register the meta-tool.
   */
  private async initializeCapabilityDiscoveryEngine(
    turnPlanningConfig: AgentOSTurnPlanningConfig,
  ): Promise<ICapabilityDiscoveryEngine | undefined> {
    const discoveryConfig = turnPlanningConfig.discovery;
    if (discoveryConfig?.enabled === false) {
      return undefined;
    }
    if (discoveryConfig?.autoInitializeEngine === false) {
      return undefined;
    }

    const defaultProvider =
      this.deps.modelProviderManager.getDefaultProvider() ??
      this.deps.modelProviderManager.getProvider(
        this.deps.modelProviderManagerConfig.providers.find((p) => p.enabled)?.providerId || '',
      );
    const providerId = defaultProvider?.providerId;
    if (!providerId) {
      this.deps.logger.warn('Capability discovery disabled: no model provider available');
      return undefined;
    }

    const embeddingDefaults = DISCOVERY_EMBEDDING_DEFAULTS[providerId];
    if (!embeddingDefaults) {
      this.deps.logger.warn(
        'Capability discovery disabled: no embedding defaults for provider',
        { providerId },
      );
      return undefined;
    }

    const embeddingModelId = discoveryConfig?.embeddingModelId ?? embeddingDefaults.modelId;
    const embeddingDimension = discoveryConfig?.embeddingDimension ?? embeddingDefaults.dimension;

    const embeddingManager = new EmbeddingManager();
    await embeddingManager.initialize(
      {
        embeddingModels: [
          {
            modelId: embeddingModelId,
            providerId,
            dimension: embeddingDimension,
            isDefault: true,
          },
        ],
        defaultModelId: embeddingModelId,
        enableCache: true,
        cacheMaxSize: 500,
        cacheTTLSeconds: 3600,
      },
      this.deps.modelProviderManager,
    );

    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize({
      id: 'agentos-capability-discovery',
      type: 'in_memory',
    });

    const engine = new CapabilityDiscoveryEngine(
      embeddingManager,
      vectorStore,
      discoveryConfig?.config,
    );
    const curatedManifestDescriptors = await loadCuratedManifestDescriptors(this.deps.logger);
    const sources = this.indexSourcesWithCurated(discoveryConfig?.sources, curatedManifestDescriptors);
    await engine.initialize(sources, discoveryConfig?.sources?.presetCoOccurrences);

    if (discoveryConfig?.registerMetaTool !== false) {
      const existingDiscover = await this.deps.toolOrchestrator.getTool('discover_capabilities');
      if (!existingDiscover) {
        await this.deps.toolOrchestrator.registerTool(
          createDiscoverCapabilitiesTool(engine, this.deps.toolOrchestrator),
        );
      }
      const existingLoad = await this.deps.toolOrchestrator.getTool('load_capability_extension');
      if (!existingLoad) {
        await this.deps.toolOrchestrator.registerTool(
          createLoadCapabilityExtensionTool(this.deps.toolOrchestrator),
        );
      }
    }

    this._embeddingManager = embeddingManager;
    this._vectorStore = vectorStore;

    this.deps.logger.info('Capability discovery engine initialized', {
      providerId,
      embeddingModelId,
      indexedCapabilities: engine.listCapabilityIds().length,
    });

    return engine;
  }
}
