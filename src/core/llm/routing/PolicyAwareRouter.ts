/**
 * @fileoverview Policy-aware model router that selects uncensored LLMs for
 * mature/private-adult content policy tiers.
 *
 * For safe/standard tiers (or when no policy tier is specified), the router
 * delegates to an optional base router or returns null, letting the caller
 * fall back to its own default model. For mature/private-adult tiers, it
 * consults the {@link UncensoredModelCatalog} and returns an OpenRouter model
 * wrapped in a minimal {@link ModelRouteResult}.
 *
 * @module core/llm/routing/PolicyAwareRouter
 */

import type { IModelRouter, ModelRouteParams, ModelRouteResult } from './IModelRouter';
import type { ModelInfo } from '../providers/IProvider';
import type {
  UncensoredModelCatalog,
  PolicyTier,
  CatalogEntry,
} from './UncensoredModelCatalog';
import { catalogEntryHasCapability } from './UncensoredModelCatalog.js';

/**
 * Manual override map: policyTier -> fixed modelId.
 * When provided, bypasses catalog lookup for the specified tier.
 */
export type PolicyOverrides = Partial<Record<PolicyTier, string>>;

/**
 * Policy-aware router that wraps an optional base router and injects
 * uncensored model selection for mature/private-adult policy tiers.
 */
export class PolicyAwareRouter implements IModelRouter {
  public readonly routerId = 'policy_aware_router_v1';

  private readonly catalog: UncensoredModelCatalog;
  private readonly baseRouter: IModelRouter | null;
  private readonly overrides: PolicyOverrides;
  private readonly defaultPolicyTier: PolicyTier | undefined;

  /**
   * @param catalog - Uncensored model catalog for mature/private-adult lookup.
   * @param baseRouter - Optional delegate for safe/standard tiers.
   * @param overrides - Per-tier model ID overrides that bypass catalog lookup.
   * @param defaultPolicyTier - Fallback tier when params.policyTier is absent.
   */
  constructor(
    catalog: UncensoredModelCatalog,
    baseRouter?: IModelRouter | null,
    overrides?: PolicyOverrides,
    defaultPolicyTier?: PolicyTier,
  ) {
    this.catalog = catalog;
    this.baseRouter = baseRouter ?? null;
    this.overrides = overrides ?? {};
    this.defaultPolicyTier = defaultPolicyTier;
  }

  /**
   * The tier this router's selection applies when a request carries none. A
   * mature or private-adult default is routed here; a safe or standard
   * default hands the request to the base router unchanged, so the base's own
   * tier decides, and the wrapper's default stands only when the base has none.
   */
  get policyTier(): PolicyTier | undefined {
    const own = this.defaultPolicyTier;
    if (own === 'mature' || own === 'private-adult') return own;
    return this.baseRouter?.policyTier ?? own;
  }

  /**
   * No-op initialization. The PolicyAwareRouter is stateless beyond its
   * constructor arguments; it does not require async setup.
   */
  async initialize(
    _config: Record<string, any>,
    _providerManager: any,
    _promptEngine?: any,
  ): Promise<void> {
    // Intentionally empty: catalog is injected, no async work needed.
  }

  /**
   * Select a model based on the request's policy tier.
   *
   * - safe / standard / absent (no default): delegate to baseRouter or return null.
   * - mature / private-adult: check overrides, then catalog, return OpenRouter result.
   */
  async selectModel(
    params: ModelRouteParams,
    availableModels?: ModelInfo[],
  ): Promise<ModelRouteResult | null> {
    const tier: PolicyTier | undefined =
      params.policyTier ?? this.defaultPolicyTier;

    // Safe / standard / absent tier: delegate or return null
    if (!tier || tier === 'safe' || tier === 'standard') {
      if (this.baseRouter) {
        return this.baseRouter.selectModel(params, availableModels);
      }
      return null;
    }

    // Check per-tier override first
    const overrideModelId = this.overrides[tier];
    if (overrideModelId) {
      return this.buildResult(overrideModelId, 'openrouter', `Override for ${tier} tier`);
    }

    // Required capabilities filtering: when the caller needs specific
    // capabilities (e.g. `json_mode` for structured output), only return
    // uncensored models that explicitly support them. A capability matches
    // under either spelling, as in the fallback walk: a call with tools
    // requires `function_calling`, which the catalog lists as `tool_use`. This prevents the
    // router from picking a prose-only model like Dolphin Mixtral when the
    // agent has set `output: someZodSchema`, which would fail Zod validation
    // because the model returns natural language instead of JSON.
    const required = params.requiredCapabilities ?? [];
    if (required.length > 0) {
      const candidates = this.catalog
        .getTextModels({ contentPermissions: this.permissionsForTier(tier, params.contentIntent) })
        .filter((entry) => required.every((cap) => catalogEntryHasCapability(entry, cap)))
        .sort((a, b) => this.qualityRank(b.quality) - this.qualityRank(a.quality));

      if (candidates.length > 0) {
        const pick = candidates[0];
        return this.buildResult(
          pick.modelId,
          pick.providerId,
          `Catalog selection for ${tier} tier with required capabilities [${required.join(', ')}] (${pick.displayName})`,
        );
      }

      // No uncensored model supports the required capabilities. Fall through
      // to the base router so a JSON-capable censored model can handle this
      // call. Structured output is more important than uncensored routing
      // for world-building / schema-shaped responses; explicit prose routing
      // still kicks in downstream for narrator / companion turns.
      if (this.baseRouter) {
        return this.baseRouter.selectModel(params, availableModels);
      }
      return null;
    }

    // No required capabilities — use the default tier-preferred model
    const entry = this.catalog.getPreferredTextModel(tier, params.contentIntent);
    if (entry) {
      return this.buildResult(
        entry.modelId,
        entry.providerId,
        `Catalog selection for ${tier} tier (${entry.displayName})`,
      );
    }

    return null;
  }

  /**
   * Map a policy tier + optional content intent to the content permission
   * tags the catalog filter requires. Used when filtering for capabilities.
   */
  private permissionsForTier(
    tier: PolicyTier,
    contentIntent?: CatalogEntry['contentPermissions'][number],
  ): CatalogEntry['contentPermissions'] {
    if (contentIntent) return [contentIntent];
    return tier === 'private-adult' ? ['erotic'] : ['romantic'];
  }

  /** Numeric quality ranking for `sort()`. Higher is better. */
  private qualityRank(q: CatalogEntry['quality']): number {
    return q === 'high' ? 3 : q === 'medium' ? 2 : 1;
  }

  /**
   * Build a minimal {@link ModelRouteResult} with a stub provider.
   * The provider stub satisfies the interface contract while signalling to
   * upstream consumers that the actual provider instance must be resolved
   * from the provider manager using the returned providerId.
   */
  private buildResult(
    modelId: string,
    providerId: string,
    reasoning: string,
  ): ModelRouteResult {
    return {
      provider: {
        providerId,
        isInitialized: false,
        async initialize() {},
        async generateCompletion() {
          throw new Error('Stub provider — resolve via AIModelProviderManager');
        },
        // eslint-disable-next-line require-yield
        async *generateCompletionStream() {
          throw new Error('Stub provider — resolve via AIModelProviderManager');
        },
        async generateEmbeddings() {
          throw new Error('Stub provider — resolve via AIModelProviderManager');
        },
        async listAvailableModels() {
          return [];
        },
        async getModelInfo() {
          return undefined;
        },
        async checkHealth() {
          return { isHealthy: false };
        },
        async shutdown() {},
      },
      modelId,
      modelInfo: {
        modelId,
        providerId,
        capabilities: ['chat'],
      },
      reasoning,
      confidence: 0.85,
      metadata: { source: this.routerId, policyRouted: true },
    };
  }
}
