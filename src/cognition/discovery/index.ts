/**
 * Capability Discovery Engine barrel exports.
 *
 * @module @framers/agentos/discovery
 *
 * Smart, tiered capability discovery for AgentOS agents.
 * Reduces capability context by ~90% (from ~20,000 to ~1,850 tokens)
 * while improving discovery accuracy through semantic search + graph re-ranking.
 *
 * @example
 * ```typescript
 * import {
 *   CapabilityDiscoveryEngine,
 *   CapabilityManifestScanner,
 *   createDiscoverCapabilitiesTool,
 *   createLoadCapabilityExtensionTool,
 * } from '@framers/agentos/discovery';
 *
 * // Initialize
 * const engine = new CapabilityDiscoveryEngine(embeddingManager, vectorStore);
 * await engine.initialize({ tools, skills, extensions, channels });
 *
 * // Per-turn discovery
 * const result = await engine.discover("search the web for AI news");
 * const contextText = engine.renderForPrompt(result);
 *
 * // Register meta-tool for agent self-discovery
 * const metaTool = createDiscoverCapabilitiesTool(engine);
 * toolOrchestrator.registerTool(metaTool);
 *
 * // Activate lazy-loadable extension packs on demand
 * const loadTool = createLoadCapabilityExtensionTool(toolOrchestrator);
 * toolOrchestrator.registerTool(loadTool);
 * ```
 */

// Types
export type {
  CapabilityKind,
  CapabilitySourceRef,
  CapabilityDescriptor,
  CapabilityTier,
  Tier1Result,
  Tier2Result,
  TokenEstimate,
  DiscoveryDiagnostics,
  CapabilityDiscoveryResult,
  CapabilityDiscoveryConfig,
  CapabilityEdgeType,
  CapabilityEdge,
  RelatedCapability,
  ICapabilityGraph,
  PresetCoOccurrence,
  CapabilitySearchResult,
  CapabilityIndexSources,
  CapabilityManifestFile,
  CapabilityManifestField,
  CapabilityManifestProblem,
  CapabilityManifestScanResult,
  RefusedCapabilityManifest,
  DiscoveryQueryOptions,
  ICapabilityDiscoveryEngine,
} from './types.js';

// Constants
export { DEFAULT_DISCOVERY_CONFIG } from './types.js';

// Core classes
export { CapabilityDiscoveryEngine } from './CapabilityDiscoveryEngine.js';
export { CapabilityIndex } from './CapabilityIndex.js';
export { CapabilityGraph } from './CapabilityGraph.js';
export { Neo4jCapabilityGraph } from './Neo4jCapabilityGraph.js';
export { CapabilityContextAssembler } from './CapabilityContextAssembler.js';
export { CapabilityEmbeddingStrategy } from './CapabilityEmbeddingStrategy.js';
export {
  CapabilityManifestRefusedError,
  CapabilityManifestScanner,
  resolveSkillContentPath,
} from './CapabilityManifestScanner.js';

// Meta-tool
export { createDiscoverCapabilitiesTool } from './DiscoverCapabilitiesTool.js';
export { createLoadCapabilityExtensionTool } from './LoadCapabilityExtensionTool.js';
