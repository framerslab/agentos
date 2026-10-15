/**
 * @fileoverview Core types for the Capability Discovery Engine.
 * @module @framers/agentos/discovery/types
 *
 * Provides unified type definitions for normalizing tools, skills, extensions,
 * and channels into a searchable, tiered capability discovery system.
 *
 * Key concepts:
 * - CapabilityDescriptor: Unified shape for any capability in the system
 * - Three-tier context budgeting: Always → Retrieved summaries → Full details
 * - ICapabilityGraph: Abstraction for relationship graphs (graphology now, Neo4j later)
 */

import type { JSONSchemaObject } from '../../core/tools/ITool.js';
import type { RelativePathProblem } from '../../core/utils/pathName.js';
import type { EmergentTool } from '../emergent/types.js';

// ============================================================================
// CAPABILITY DESCRIPTOR
// ============================================================================

/**
 * Kind discriminator for capability descriptors.
 */
export type CapabilityKind = 'tool' | 'skill' | 'extension' | 'channel' | 'voice' | 'productivity' | 'emergent-tool';

/**
 * Reference back to the original source of a capability.
 * Used for lazy loading of full schemas/content.
 */
export type CapabilitySourceRef =
  | { type: 'tool'; toolName: string }
  | { type: 'skill'; skillName: string; skillPath?: string }
  | { type: 'extension'; packageName: string; extensionId: string }
  | { type: 'channel'; platform: string }
  | { type: 'manifest'; manifestPath: string; entryId: string }
  | { type: 'emergent-tool'; emergentToolId: string; tier: string };

/**
 * Unified representation of any capability in the system.
 * Normalizes tools, skills, extensions, and channels into a single
 * searchable shape for the discovery engine.
 */
export interface CapabilityDescriptor {
  /**
   * Globally unique ID.
   * Convention: `${kind}:${name}` (e.g., "tool:web-search", "skill:github", "channel:telegram")
   */
  id: string;

  /** Kind discriminator */
  kind: CapabilityKind;

  /** Machine-readable name (e.g., "web-search", "github", "telegram") */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /**
   * Natural language description.
   * This is the primary text used for embedding generation — it should
   * describe WHEN and WHY to use this capability, not just what it does.
   */
  description: string;

  /** Category for coarse filtering (e.g., "information", "developer-tools", "communication") */
  category: string;

  /** Tags for additional matching signals */
  tags: string[];

  /** Required secret IDs (e.g., ["SERPER_API_KEY", "OPENAI_API_KEY"]) */
  requiredSecrets: string[];

  /** Required tool/binary dependencies (e.g., ["gh", "git"]) */
  requiredTools: string[];

  /** Whether this capability is currently available (installed, secrets present) */
  available: boolean;

  /** Whether this capability has side effects on external systems */
  hasSideEffects?: boolean;

  /**
   * Full input/output schema (Tier 2 data — NOT embedded, loaded on demand).
   * For tools: the JSON Schema inputSchema + outputSchema.
   */
  fullSchema?: JSONSchemaObject;

  /**
   * Full SKILL.md content or detailed documentation (Tier 2 data — NOT embedded, loaded on demand).
   */
  fullContent?: string;

  /** Reference back to the original source for lazy loading */
  sourceRef: CapabilitySourceRef;
}

// ============================================================================
// TIER SYSTEM
// ============================================================================

/**
 * Tier classification for context budget management.
 *
 * Tier 0: Always in context (~150 tokens) — category summaries only
 * Tier 1: Retrieved on relevance (~200 tokens) — name + description + key params
 * Tier 2: Deep pull (~1500 tokens) — full schema + examples + relationship context
 */
export enum CapabilityTier {
  /** Always in context: category summaries */
  TIER_0_ALWAYS = 0,
  /** Retrieved on relevance: name + description + key params */
  TIER_1_SUMMARY = 1,
  /** Deep pull: full schema + examples + relationship context */
  TIER_2_FULL = 2,
}

// ============================================================================
// DISCOVERY RESULT
// ============================================================================

/**
 * A Tier 1 search result with relevance scoring.
 */
export interface Tier1Result {
  capability: CapabilityDescriptor;
  relevanceScore: number;
  /** Compact summary text (~30-50 tokens per capability) */
  summaryText: string;
}

/**
 * A Tier 2 full-detail result.
 */
export interface Tier2Result {
  capability: CapabilityDescriptor;
  /** Full schema/content text for injection into context */
  fullText: string;
}

/**
 * Token budget tracking for a discovery result.
 */
export interface TokenEstimate {
  tier0Tokens: number;
  tier1Tokens: number;
  tier2Tokens: number;
  totalTokens: number;
}

/**
 * Performance diagnostics for a discovery query.
 */
export interface DiscoveryDiagnostics {
  queryTimeMs: number;
  embeddingTimeMs: number;
  graphTraversalTimeMs: number;
  candidatesScanned: number;
  capabilitiesRetrieved: number;
}

/**
 * Complete result of a capability discovery query.
 * Contains all three tiers of context, plus diagnostics.
 */
export interface CapabilityDiscoveryResult {
  /** Tier 0: always-present category summaries */
  tier0: string;
  /** Tier 1: retrieved capability summaries with scores */
  tier1: Tier1Result[];
  /** Tier 2: full details for top-selected capabilities */
  tier2: Tier2Result[];
  /** Token budget tracking */
  tokenEstimate: TokenEstimate;
  /** Discovery diagnostics */
  diagnostics: DiscoveryDiagnostics;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Configuration for the Capability Discovery Engine.
 */
export interface CapabilityDiscoveryConfig {
  /** Maximum tokens for Tier 0 context. @default 200 */
  tier0TokenBudget: number;
  /** Maximum tokens for Tier 1 retrievals. @default 800 */
  tier1TokenBudget: number;
  /** Maximum tokens for Tier 2 full pulls. @default 2000 */
  tier2TokenBudget: number;
  /** Number of Tier 1 candidates to retrieve. @default 5 */
  tier1TopK: number;
  /** Number of Tier 2 candidates to fully expand. @default 2 */
  tier2TopK: number;
  /** Minimum relevance score for Tier 1 inclusion (0-1). @default 0.3 */
  tier1MinRelevance: number;
  /** Whether to use graph relationships for re-ranking. @default true */
  useGraphReranking: boolean;
  /** Vector store collection name for capability embeddings. @default 'capability_index' */
  collectionName: string;
  /** Embedding model ID to use (undefined = use default). */
  embeddingModelId?: string;
  /** Graph-based boost factor for related capabilities (0-1). @default 0.15 */
  graphBoostFactor: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_DISCOVERY_CONFIG: Readonly<CapabilityDiscoveryConfig> = {
  tier0TokenBudget: 200,
  tier1TokenBudget: 800,
  tier2TokenBudget: 2000,
  tier1TopK: 5,
  tier2TopK: 2,
  tier1MinRelevance: 0.3,
  useGraphReranking: true,
  collectionName: 'capability_index',
  graphBoostFactor: 0.15,
};

// ============================================================================
// CAPABILITY GRAPH INTERFACE
// ============================================================================

/**
 * Edge types in the capability relationship graph.
 */
export type CapabilityEdgeType =
  | 'DEPENDS_ON'      // Skill requires a tool (from requiredTools)
  | 'COMPOSED_WITH'   // Capabilities that co-occur in presets
  | 'SAME_CATEGORY'   // Capabilities sharing a category (weak signal)
  | 'TAGGED_WITH';    // Capabilities sharing tags (weighted by overlap count)

/**
 * A relationship edge between two capabilities.
 */
export interface CapabilityEdge {
  sourceId: string;
  targetId: string;
  type: CapabilityEdgeType;
  weight: number;
}

/**
 * A related capability returned from graph traversal.
 */
export interface RelatedCapability {
  id: string;
  weight: number;
  relationType: CapabilityEdgeType;
}

/**
 * Abstraction for capability relationship graphs.
 * Implemented by graphology now; can be swapped for Neo4j later.
 */
export interface ICapabilityGraph {
  /**
   * Build the graph from capability descriptors and preset co-occurrence data.
   */
  buildGraph(
    capabilities: CapabilityDescriptor[],
    presetCoOccurrences?: PresetCoOccurrence[],
  ): void | Promise<void>;

  /**
   * Get capabilities related to a given capability (1-hop neighbors).
   */
  getRelated(capabilityId: string): RelatedCapability[];

  /**
   * Get the subgraph for a set of capability IDs.
   */
  getSubgraph(capabilityIds: string[]): {
    nodes: string[];
    edges: CapabilityEdge[];
  };

  /** Number of nodes in the graph. */
  nodeCount(): number;

  /** Number of edges in the graph. */
  edgeCount(): number;

  /** Clear the graph. */
  clear(): void;
}

/**
 * Co-occurrence data from agent presets.
 * Captures which capabilities are suggested together.
 */
export interface PresetCoOccurrence {
  presetName: string;
  capabilityIds: string[];
}

// ============================================================================
// INDEX INTERFACE
// ============================================================================

/**
 * A scored search result from the capability index.
 */
export interface CapabilitySearchResult {
  descriptor: CapabilityDescriptor;
  score: number;
}

/**
 * Sources for building the capability index.
 */
export interface CapabilityIndexSources {
  /** Tool descriptors (from ToolOrchestrator or ITool[]) */
  tools?: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    category?: string;
    inputSchema: JSONSchemaObject;
    outputSchema?: JSONSchemaObject;
    requiredCapabilities?: string[];
    hasSideEffects?: boolean;
  }>;

  /** Skill entries (from SkillRegistry) */
  skills?: Array<{
    name: string;
    description: string;
    content: string;
    category?: string;
    tags?: string[];
    requiredSecrets?: string[];
    requiredTools?: string[];
    sourcePath?: string;
    metadata?: {
      primaryEnv?: string;
      requires?: { bins?: string[] };
    };
  }>;

  /** Extension catalog entries */
  extensions?: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    category: string;
    requiredSecrets?: string[];
    available?: boolean;
  }>;

  /** Channel catalog entries */
  channels?: Array<{
    platform: string;
    displayName: string;
    description: string;
    tier?: string;
    capabilities?: string[];
  }>;

  /** File-based manifest entries */
  manifests?: CapabilityDescriptor[];
}

// ============================================================================
// MANIFEST FILE FORMAT
// ============================================================================

/**
 * Structure of a CAPABILITY.yaml manifest file.
 */
export interface CapabilityManifestFile {
  id: string;
  kind: CapabilityKind;
  name: string;
  displayName: string;
  description: string;
  category: string;
  tags?: string[];
  requiredSecrets?: string[];
  requiredTools?: string[];
  hasSideEffects?: boolean;
  inputSchema?: JSONSchemaObject;
  /**
   * The file that holds the skill's content, read as the capability's `fullContent`: a path below the capability's
   * folder, its names joined by `/` after an optional leading `./`, such as `./SKILL.md` or `docs/skill.md`. No name
   * in it is empty, `.` or `..`, starts with a dot, starts or ends with a space or ends with a dot, or holds more
   * than 200 bytes in UTF-8, and it holds no backslash, no colon, none of `"`, `*`, `<`, `>`, `?` and `|` and no
   * control character, so it never leaves the folder. A value the manifest sets is held to the rule whatever it is, so
   * an empty value, YAML's null (no value, `null` or `~`, which the scanner reads as empty), `false` or a number is
   * refused too. A manifest whose `skillContent` breaks the rule is refused, and the capability with it. When the
   * manifest does not set it, `SKILL.md` beside the manifest is read when it is there.
   */
  skillContent?: string;
}

/**
 * What a refused capability's refusal names:
 * - `'manifest'`: the manifest file itself, `CAPABILITY.yaml` or `CAPABILITY.yml`.
 * - `'skillContent'`: the skill's content: the manifest's `skillContent` value and the file it names, or
 *   `SKILL.md` beside the manifest when it names none.
 * - `'schema'`: `schema.json` beside the manifest, read when the manifest sets no `inputSchema`.
 */
export type CapabilityManifestField = 'manifest' | 'skillContent' | 'schema';

/**
 * Why a capability was refused:
 * - `'type'`: `skillContent` is not a string.
 * - `'empty'`, `'character'`, `'segment'`, `'dot'`, `'edge'` and `'length'`: `skillContent` breaks the rule for a
 *   path below a folder built from data (`RelativePathProblem` in `core/utils/pathName`): it names no file; it holds
 *   a backslash, a colon, one of `"`, `*`, `<`, `>`, `?` and `|`, or a control character; a name in it is empty, so
 *   it starts or ends with a slash or holds two together; a name starts with a dot; a name starts or ends with a
 *   space, or ends with a dot; or a name holds more than 200 bytes in UTF-8.
 * - `'outside'`: the file `skillContent` names would not lie inside the capability's folder.
 * - `'link'`: a symbolic link holds the place of the file, or of a folder on the way to it, the capability's own
 *   folder among them. On Linux, also when the file the open reached lies outside the capability's own folder, as
 *   when a folder on the way is swapped for a link after it was looked at.
 * - `'special'`: something other than a regular file holds the file's place: a folder, a named pipe, a socket or a
 *   device.
 */
export type CapabilityManifestProblem = 'type' | RelativePathProblem | 'outside' | 'link' | 'special';

/** A capability the manifest scanner left out, and why. */
export interface RefusedCapabilityManifest {
  /** The path of the capability's manifest. */
  manifestPath: string;
  /** What was refused. */
  field: CapabilityManifestField;
  /** Why it was refused. */
  problem: CapabilityManifestProblem;
}

/** What `CapabilityManifestScanner.scanWithRefusals()` reports. */
export interface CapabilityManifestScanResult {
  /** The capabilities read, one for each manifest accepted. */
  descriptors: CapabilityDescriptor[];
  /**
   * The capabilities left out because their `skillContent` or the place of one of their files was refused, each
   * with its manifest and the reason. A manifest that lacks `name`, `kind` or `description`, or a file that fails to
   * read for another reason, is left out with a warning and is not listed here.
   */
  refused: RefusedCapabilityManifest[];
}

// ============================================================================
// DISCOVERY ENGINE INTERFACE
// ============================================================================

/**
 * Options for a discovery query.
 */
export interface DiscoveryQueryOptions {
  /** Override default config for this query */
  config?: Partial<CapabilityDiscoveryConfig>;
  /** Filter by capability kind */
  kind?: CapabilityKind | 'any';
  /** Filter by category */
  category?: string;
  /** Only include available capabilities */
  onlyAvailable?: boolean;
  /** Exclude specific skill capability IDs or aliases from this query result. */
  excludedCapabilityIds?: string[];
}

/**
 * The main Capability Discovery Engine interface.
 */
export interface ICapabilityDiscoveryEngine {
  /**
   * Initialize the engine: build index + graph from all sources.
   */
  initialize(sources: CapabilityIndexSources): Promise<void>;

  /**
   * Discover capabilities relevant to a user message.
   * Returns a tiered, token-budgeted result.
   */
  discover(
    userMessage: string,
    options?: DiscoveryQueryOptions,
  ): Promise<CapabilityDiscoveryResult>;

  /**
   * Get full detail for a specific capability (Tier 2 pull).
   */
  getCapabilityDetail(id: string): CapabilityDescriptor | undefined;

  /**
   * Refresh the index incrementally (e.g., after manifest file changes).
   */
  refreshIndex(sources?: Partial<CapabilityIndexSources>): Promise<void>;

  /** Whether the engine is initialized. */
  isInitialized(): boolean;

  /** Get all registered capability IDs. */
  listCapabilityIds(): string[];

  /** Index promoted emergent tools into discovery. */
  indexEmergentTools?(tools: EmergentTool[]): Promise<number>;

  /** Remove emergent tools from discovery when they are deactivated or revoked. */
  removeEmergentTools?(tools: EmergentTool[]): Promise<number>;
}
