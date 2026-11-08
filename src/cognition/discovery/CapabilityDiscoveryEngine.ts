/**
 * @fileoverview Capability Discovery Engine — main orchestrator.
 * @module @framers/agentos/discovery/CapabilityDiscoveryEngine
 *
 * Coordinates the capability index, relationship graph, and context assembler
 * to provide tiered, semantic capability discovery for AgentOS agents.
 *
 * Architecture:
 *   User Message → CapabilityIndex.search() → CapabilityGraph.rerank()
 *                → CapabilityContextAssembler.assemble() → CapabilityDiscoveryResult
 *
 * Performance targets:
 *   - Initialize: ~3s (one-time embedding generation for ~100 capabilities)
 *   - Per-turn discover(): ~50ms cold (embedding) / ~5ms warm (cache hit)
 *   - Context tokens: ~1,850 (down from ~20,000 with static dumps)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IEmbeddingManager } from '../../core/embeddings/IEmbeddingManager.js';
import type { IVectorStore } from '../../core/vector-store/IVectorStore.js';
import type {
  CapabilityDiscoveryConfig,
  CapabilityDiscoveryResult,
  CapabilityDescriptor,
  CapabilityIndexSources,
  DiscoveryQueryOptions,
  ICapabilityDiscoveryEngine,
  PresetCoOccurrence,
} from './types.js';
import type { EmergentTool } from '../emergent/types.js';
import { DEFAULT_DISCOVERY_CONFIG } from './types.js';
import { CapabilityIndex } from './CapabilityIndex.js';
import { CapabilityGraph } from './CapabilityGraph.js';
import { CapabilityContextAssembler } from './CapabilityContextAssembler.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CAPABILITY DISCOVERY ENGINE
// ============================================================================

export class CapabilityDiscoveryEngine implements ICapabilityDiscoveryEngine {
  private readonly index: CapabilityIndex;
  private readonly graph: CapabilityGraph;
  private readonly assembler: CapabilityContextAssembler;
  private readonly config: CapabilityDiscoveryConfig;
  private indexVersion = 0;
  private initialized = false;

  constructor(
    embeddingManager: IEmbeddingManager,
    vectorStore: IVectorStore,
    config?: Partial<CapabilityDiscoveryConfig>
  ) {
    this.config = { ...DEFAULT_DISCOVERY_CONFIG, ...config };
    this.index = new CapabilityIndex(
      embeddingManager,
      vectorStore,
      this.config.collectionName,
      this.config.embeddingModelId
    );
    this.graph = new CapabilityGraph();
    this.assembler = new CapabilityContextAssembler(this.index.getEmbeddingStrategy());
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the engine: build index + graph from all capability sources.
   *
   * After building from the provided sources, the engine also attempts to
   * load the auto-generated capability catalog from
   * `@framers/agentos-extensions-registry`. This rescues extensions that have
   * no SKILL.md and are not registered in the tool/channel/provider catalogs
   * by converting each catalog entry into a discoverable CapabilityDescriptor.
   *
   * The catalog import is non-fatal — if the registry package is not installed,
   * initialization proceeds with the explicit sources only.
   *
   * @param sources - Tools, skills, extensions, channels, and manifest entries
   * @param presetCoOccurrences - Co-occurrence data from agent presets
   */
  async initialize(
    sources: CapabilityIndexSources,
    presetCoOccurrences?: PresetCoOccurrence[]
  ): Promise<void> {
    // 1. Build the vector index (normalizes sources + embeds + stores)
    await this.index.buildIndex(sources);

    // 2. Hydrate from the extensions-registry capability catalog (non-fatal)
    await this.hydrateFromCapabilityCatalog();

    // 3. Build the relationship graph (async — graphology loaded lazily)
    const allCapabilities = this.index.getAllCapabilities();
    await this.graph.buildGraph(allCapabilities, presetCoOccurrences);

    this.indexVersion++;
    this.initialized = true;
  }

  // ============================================================================
  // DISCOVERY
  // ============================================================================

  /**
   * Discover capabilities relevant to a user message.
   *
   * Flow:
   * 1. Semantic search against capability embeddings
   * 2. Graph-based re-ranking (boost related capabilities)
   * 3. Token-budgeted tiered assembly
   *
   * Returns a CapabilityDiscoveryResult with Tier 0/1/2 context.
   */
  async discover(
    userMessage: string,
    options?: DiscoveryQueryOptions
  ): Promise<CapabilityDiscoveryResult> {
    if (!this.initialized) {
      return this.emptyResult();
    }

    const queryConfig = { ...this.config, ...options?.config };
    const embeddingStart = performance.now();

    // 1. Semantic search
    // Retrieve more candidates than needed for graph re-ranking to work effectively
    const searchTopK = queryConfig.tier1TopK * 2;
    const searchResults = await this.index.search(userMessage, searchTopK, {
      kind: options?.kind,
      category: options?.category,
      onlyAvailable: options?.onlyAvailable,
      excludedCapabilityIds: options?.excludedCapabilityIds,
    });

    const embeddingTimeMs = performance.now() - embeddingStart;

    // 2. Graph-based re-ranking
    let finalResults = searchResults;
    let graphTraversalTimeMs = 0;

    if (queryConfig.useGraphReranking && searchResults.length > 0) {
      const graphStart = performance.now();

      const reranked = this.graph.rerank(
        searchResults.map((r) => ({ id: r.descriptor.id, score: r.score })),
        queryConfig.graphBoostFactor
      );

      // Map back to CapabilitySearchResult format
      finalResults = reranked
        .map((r) => {
          const descriptor = this.index.getCapability(r.id);
          if (!descriptor) return null;
          return { descriptor, score: r.score };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      graphTraversalTimeMs = performance.now() - graphStart;
    }

    // 3. Build Tier 0 category summary
    const tier0 = this.assembler.buildTier0(
      filterCapabilitiesForDiscovery(this.index.getAllCapabilities(), options?.excludedCapabilityIds),
      this.indexVersion,
    );

    // 4. Assemble tiered result with token budgets
    return this.assembler.assemble(tier0, finalResults, queryConfig, {
      embeddingTimeMs,
      graphTraversalTimeMs,
    });
  }

  // ============================================================================
  // DETAIL ACCESS
  // ============================================================================

  /**
   * Get full detail for a specific capability by ID.
   */
  getCapabilityDetail(id: string): CapabilityDescriptor | undefined {
    return this.index.getCapability(id);
  }

  // ============================================================================
  // INDEX MANAGEMENT
  // ============================================================================

  /**
   * Refresh the index incrementally.
   * Called when manifest files change or new capabilities are added at runtime.
   */
  async refreshIndex(sources?: Partial<CapabilityIndexSources>): Promise<void> {
    if (!sources) return;

    // Normalize and upsert new sources
    const fullSources: CapabilityIndexSources = {
      tools: sources.tools,
      skills: sources.skills,
      extensions: sources.extensions,
      channels: sources.channels,
      manifests: sources.manifests,
    };

    const newDescriptors = this.index.normalizeSources(fullSources);

    // One embeddings call for the whole refresh; the embedding manager sends it in batches.
    await this.index.upsertCapabilities(newDescriptors);

    // Rebuild graph with all capabilities (async — graphology loaded lazily)
    const allCapabilities = this.index.getAllCapabilities();
    await this.graph.buildGraph(allCapabilities);

    this.indexVersion++;
    this.assembler.invalidateCache();
  }

  // ============================================================================
  // EMERGENT TOOL INDEXING
  // ============================================================================

  /**
   * Index emergent tools into the capability discovery system.
   *
   * Converts `EmergentTool` objects to `CapabilityDescriptor` records and
   * upserts them into the vector index and relationship graph. Session-tier tools
   * are skipped because they are too ephemeral to warrant indexing overhead.
   *
   * Each emergent tool becomes a descriptor with:
   * - `id: 'emergent-tool:${tool.name}'`
   * - `kind: 'emergent-tool'`
   * - `category: 'emergent'`
   * - `tags: ['runtime-created', 'agent-forged', implementation.mode]`
   * - `hasSideEffects: true` when the implementation mode is `'sandbox'`
   *
   * @param tools - Array of emergent tools to index. Session-tier entries are filtered out.
   * @returns The number of tools actually indexed (excluding skipped session-tier tools).
   */
  async indexEmergentTools(tools: EmergentTool[]): Promise<number> {
    // Filter out session-tier tools — too ephemeral for discovery indexing
    const eligible = tools.filter((t) => t.tier !== 'session');

    if (eligible.length === 0) return 0;

    const descriptors: CapabilityDescriptor[] = eligible.map((tool) => ({
      id: `emergent-tool:${tool.name}`,
      kind: 'emergent-tool' as const,
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      category: 'emergent',
      tags: ['runtime-created', 'agent-forged', tool.implementation.mode],
      requiredSecrets: [],
      requiredTools: [],
      available: true,
      hasSideEffects: tool.implementation.mode === 'sandbox',
      fullSchema: tool.inputSchema,
      sourceRef: {
        type: 'emergent-tool' as const,
        emergentToolId: tool.id,
        tier: tool.tier,
      },
    }));

    await this.index.upsertCapabilities(descriptors);

    // Rebuild graph to include new emergent-tool nodes
    const allCapabilities = this.index.getAllCapabilities();
    await this.graph.buildGraph(allCapabilities);

    this.indexVersion++;
    this.assembler.invalidateCache();

    return descriptors.length;
  }

  /**
   * Remove emergent tools from the discovery index.
   *
   * This is used when a promoted/shared tool is deactivated or revoked and
   * should no longer be returned by semantic capability discovery.
   */
  async removeEmergentTools(tools: EmergentTool[]): Promise<number> {
    const eligible = tools.filter((t) => t.tier !== 'session');

    if (eligible.length === 0) return 0;

    let removed = 0;
    for (const tool of eligible) {
      await this.index.removeCapability(`emergent-tool:${tool.name}`);
      removed += 1;
    }

    const allCapabilities = this.index.getAllCapabilities();
    await this.graph.buildGraph(allCapabilities);

    this.indexVersion++;
    this.assembler.invalidateCache();

    return removed;
  }

  // ============================================================================
  // ACCESSORS
  // ============================================================================

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get Tier 0 category summaries for all indexed capabilities.
   *
   * Returns a compact (~150 tokens) overview of available capability
   * categories, suitable for injection into LLM classification prompts.
   * This allows the classifier to reason about what capabilities exist
   * without loading full schemas.
   *
   * Returns an empty string when the engine is not initialized.
   *
   * @returns Tier 0 summary text, or empty string if uninitialized.
   *
   * @example
   * ```typescript
   * const summaries = engine.getTier0Summaries();
   * // "Available capability categories:\n- Information: web-search, deep-research (+2 more) (4)\n..."
   * ```
   */
  getTier0Summaries(): string {
    if (!this.initialized) {
      return '';
    }
    return this.assembler.buildTier0(this.index.getAllCapabilities(), this.indexVersion);
  }

  /**
   * Get Tier 0 category summaries filtered by capability kind.
   *
   * Produces separate summaries for skills, tools, and extensions so the
   * classifier can reason about each category independently.
   *
   * @returns Object with `skills`, `tools`, and `extensions` summary strings.
   */
  getTier0SummariesByKind(
    excludedCapabilityIds?: string[],
  ): { skills: string; tools: string; extensions: string } {
    if (!this.initialized) {
      return { skills: '', tools: '', extensions: '' };
    }

    const allCapabilities = filterCapabilitiesForDiscovery(
      this.index.getAllCapabilities(),
      excludedCapabilityIds,
    );

    const filterByKind = (kinds: string[]): CapabilityDescriptor[] =>
      allCapabilities.filter((c) => kinds.includes(c.kind));

    // Build separate summaries using a fresh assembler to avoid polluting the cache
    const tempAssembler = new CapabilityContextAssembler(this.assembler['strategy']);

    return {
      skills: tempAssembler.buildTier0(filterByKind(['skill']), -1),
      tools: tempAssembler.buildTier0(filterByKind(['tool', 'emergent-tool']), -2),
      extensions: tempAssembler.buildTier0(filterByKind(['extension', 'channel', 'voice', 'productivity']), -3),
    };
  }

  listCapabilityIds(): string[] {
    return this.index.listIds();
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<CapabilityDiscoveryConfig> {
    return this.config;
  }

  /**
   * Get index statistics.
   */
  getStats(): {
    capabilityCount: number;
    graphNodes: number;
    graphEdges: number;
    indexVersion: number;
  } {
    return {
      capabilityCount: this.index.size(),
      graphNodes: this.graph.nodeCount(),
      graphEdges: this.graph.edgeCount(),
      indexVersion: this.indexVersion,
    };
  }

  /**
   * Render a discovery result into a string suitable for prompt injection.
   */
  renderForPrompt(result: CapabilityDiscoveryResult): string {
    return this.assembler.renderForPrompt(result);
  }

  // ============================================================================
  // CAPABILITY CATALOG HYDRATION
  // ============================================================================

  /**
   * Load the auto-generated capability catalog from `@framers/agentos-extensions-registry`
   * and register each entry as a discoverable CapabilityDescriptor.
   *
   * This closes the "discovery gap" where extensions that lack SKILL.md files
   * and are not explicitly registered in tool/channel/provider catalogs remain
   * invisible to semantic search. The catalog is generated at build time from
   * all `manifest.json` files in the curated extensions directory.
   *
   * Only entries whose ID is NOT already in the index are added, so explicit
   * registrations from `CapabilityIndexSources` always take precedence.
   *
   * The import is dynamic and non-fatal: if `@framers/agentos-extensions-registry`
   * is not installed, the method silently returns zero.
   *
   * The entries are embedded with one embeddings call, which the embedding manager
   * sends in batches (32 texts a request unless configured): a catalog of 119
   * entries costs 4 requests, not 119. This runs inside {@link initialize}, so an
   * agent's boot stays inside a provider or proxy limit on calls per minute.
   *
   * @returns The number of catalog entries injected into the index.
   */
  async hydrateFromCapabilityCatalog(): Promise<number> {
    let catalog: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      tools: string[];
      requiredSecrets: string[];
    }> = [];

    try {
      const mod = await import('@framers/agentos-extensions-registry');
      const importedCatalog =
        (mod as Record<string, unknown>).CAPABILITY_CATALOG as typeof catalog;
      if (Array.isArray(importedCatalog) && importedCatalog.length > 0) {
        catalog = importedCatalog;
      }
    } catch {
      // Fall through to the bundled platform knowledge fallback below.
    }

    if (catalog.length === 0) {
      catalog = loadBundledCapabilityCatalogFallback();
    }

    if (catalog.length === 0) {
      return 0;
    }

    const existingIds = new Set(this.index.listIds());
    const pending: CapabilityDescriptor[] = [];

    for (const entry of catalog) {
      // Skip entries already registered from explicit sources
      const candidateId = `extension:${entry.id}`;
      if (existingIds.has(candidateId) || existingIds.has(entry.id)) {
        continue;
      }

      const descriptor: CapabilityDescriptor = {
        id: candidateId,
        kind: 'extension',
        name: entry.id,
        displayName: entry.name,
        description: entry.description,
        category: entry.category || 'uncategorized',
        tags: entry.tools,
        requiredSecrets: entry.requiredSecrets ?? [],
        requiredTools: [],
        available: false, // Not loaded yet — discoverable but not active
        sourceRef: {
          type: 'extension',
          packageName: entry.id,
          extensionId: entry.id,
        },
      };

      pending.push(descriptor);
    }

    if (pending.length > 0) {
      await this.index.upsertCapabilities(pending);
    }

    return pending.length;
  }

  // ============================================================================
  // INTERNAL
  // ============================================================================

  private emptyResult(): CapabilityDiscoveryResult {
    return {
      tier0: 'No capabilities indexed. Discovery engine not initialized.',
      tier1: [],
      tier2: [],
      tokenEstimate: {
        tier0Tokens: 10,
        tier1Tokens: 0,
        tier2Tokens: 0,
        totalTokens: 10,
      },
      diagnostics: {
        queryTimeMs: 0,
        embeddingTimeMs: 0,
        graphTraversalTimeMs: 0,
        candidatesScanned: 0,
        capabilitiesRetrieved: 0,
      },
    };
  }
}

function loadBundledCapabilityCatalogFallback(): Array<{
  id: string;
  name: string;
  description: string;
  category: string;
  tools: string[];
  requiredSecrets: string[];
}> {
  const candidates = [
    // Published package layout: knowledge/ sits next to dist/
    join(MODULE_DIR, '../../knowledge/platform-corpus.json'),
    // Source layout: knowledge/ sits at package root, src/ is one level down
    join(MODULE_DIR, '../../../knowledge/platform-corpus.json'),
  ];

  for (const corpusPath of candidates) {
    if (!existsSync(corpusPath)) {
      continue;
    }

    try {
      const raw = readFileSync(corpusPath, 'utf-8');
      const entries: Array<{
        id: string;
        heading: string;
        content: string;
        category: string;
      }> = JSON.parse(raw);

      const toolEntries = entries.filter(
        (entry) => entry.category === 'tools' && /^tool-ref:/i.test(entry.id),
      );

      if (toolEntries.length === 0) {
        continue;
      }

      return toolEntries.map((entry) => {
        const id = entry.id.replace(/^tool-ref:/i, '').trim();

        return {
          id,
          name: entry.heading,
          description: extractCapabilityDescription(entry.content),
          category: deriveCapabilityCategoryFromId(id),
          tools: extractDelimitedCapabilityList(entry.content, 'Tools'),
          requiredSecrets: extractDelimitedCapabilityList(entry.content, 'Required secrets'),
        };
      });
    } catch {
      // Try the next candidate path.
    }
  }

  return [];
}

function filterCapabilitiesForDiscovery(
  capabilities: CapabilityDescriptor[],
  excludedCapabilityIds?: string[],
): CapabilityDescriptor[] {
  const normalizedExcludedCapabilityIds = Array.from(
    new Set(
      (excludedCapabilityIds ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );

  if (normalizedExcludedCapabilityIds.length === 0) {
    return capabilities;
  }

  return capabilities.filter((capability) => {
    if (capability.kind !== 'skill') {
      return true;
    }

    const aliases = Array.from(
      new Set(
        [
          capability.id,
          capability.name,
          capability.displayName,
          capability.sourceRef.type === 'skill' ? capability.sourceRef.skillName : '',
        ]
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0),
      ),
    );

    return !normalizedExcludedCapabilityIds.some((excludedId) => aliases.includes(excludedId));
  });
}

function deriveCapabilityCategoryFromId(id: string): string {
  const normalizedId = id.replace(/^com\.framers\./i, '');
  const category = normalizedId.split('.')[0]?.trim().toLowerCase();

  if (!category) {
    return 'other';
  }

  return category.endsWith('s') && category.length > 3
    ? category.slice(0, -1)
    : category;
}

function extractCapabilityDescription(content: string): string {
  const markerIndex = content.search(/\b(Tools|Required secrets):\b/i);
  if (markerIndex === -1) {
    return content.trim();
  }

  return content.slice(0, markerIndex).trim();
}

function extractDelimitedCapabilityList(content: string, label: 'Tools' | 'Required secrets'): string[] {
  const match = content.match(new RegExp(`${label}:\\s*([^.]*)\\.?`, 'i'));
  if (!match) {
    return [];
  }

  const rawValue = match[1].trim();
  if (!rawValue || /^none$/i.test(rawValue)) {
    return [];
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
