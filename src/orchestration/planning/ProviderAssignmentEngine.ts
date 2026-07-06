/**
 * @file ProviderAssignmentEngine.ts
 * @description Assigns LLM providers and models to graph nodes.
 *
 * Five strategies:
 *   best     — top model from each provider
 *   cheapest — cheapest model from each provider
 *   balanced — complexity-based tier selection
 *   explicit — user-specified per-node assignments
 *   mixed    — explicit overrides with a fallback strategy
 */

import type { GraphNode } from '../ir/types.js';
import type { ProviderStrategyConfig, NodeProviderAssignment, ExplicitAssignment } from './types.js';

/**
 * Provider defaults — mirrors PROVIDER_DEFAULTS from api/provider-defaults.ts
 * but inlined to avoid circular dependency across package boundaries.
 */
const DEFAULTS: Record<string, { text: string; cheap: string }> = {
  openai: { text: 'gpt-4o', cheap: 'gpt-4o-mini' },
  anthropic: { text: 'claude-sonnet-5', cheap: 'claude-haiku-4-5-20251001' },
  gemini: { text: 'gemini-2.5-flash', cheap: 'gemini-2.0-flash' },
  ollama: { text: 'llama3.2', cheap: 'llama3.2' },
  openrouter: { text: 'openai/gpt-4o', cheap: 'openai/gpt-4o-mini' },
  groq: { text: 'llama-3.3-70b-versatile', cheap: 'gemma2-9b-it' },
  together: {
    text: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    cheap: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  },
  mistral: { text: 'mistral-large-latest', cheap: 'mistral-small-latest' },
  xai: { text: 'grok-2', cheap: 'grok-2-mini' },
};

/** Node with an optional complexity annotation from the planner. */
type AnnotatedNode = GraphNode & { complexity?: number };

/**
 * Assigns LLM providers and models to graph nodes based on strategy.
 */
export class ProviderAssignmentEngine {
  private readonly availableProviders: string[];
  private readonly rotation = new Map<string, number>();

  constructor(availableProviders: string[]) {
    // Prefer providers we have defaults for, fall back to raw list
    const known = availableProviders.filter((p) => p in DEFAULTS);
    this.availableProviders = known.length > 0 ? known : availableProviders;
  }

  /**
   * Assign providers/models to all nodes in a graph.
   *
   * @param nodes - Graph nodes, optionally annotated with `complexity` (0-1).
   * @param config - Strategy configuration.
   */
  assign(nodes: AnnotatedNode[], config: ProviderStrategyConfig): NodeProviderAssignment[] {
    switch (config.strategy) {
      case 'best':
        return nodes.map((n) => this.assignBest(n));
      case 'cheapest':
        return nodes.map((n) => this.assignCheapest(n));
      case 'balanced':
        return nodes.map((n) => this.assignBalanced(n));
      case 'explicit':
        return nodes.map((n) => this.assignExplicit(n, config.assignments ?? {}));
      case 'mixed':
        return nodes.map((n) =>
          this.assignMixed(n, config.assignments ?? {}, config.fallback ?? 'balanced'),
        );
      default:
        return nodes.map((n) => this.assignBalanced(n));
    }
  }

  /** Check whether all required providers are available (have API keys). */
  checkAvailability(assignments: NodeProviderAssignment[]): {
    available: boolean;
    missing: string[];
  } {
    const requiredProviders = new Set(assignments.map((a) => a.provider));
    const missing = [...requiredProviders].filter((p) => !this.availableProviders.includes(p));
    return { available: missing.length === 0, missing };
  }

  // ---------------------------------------------------------------------------
  // Strategy implementations
  // ---------------------------------------------------------------------------

  private assignBest(node: AnnotatedNode): NodeProviderAssignment {
    const provider = this.pickProvider(
      'best',
      ['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'xai', 'mistral', 'together', 'ollama'],
    );
    const defaults = DEFAULTS[provider];
    return {
      nodeId: node.id,
      provider,
      model: defaults?.text ?? 'gpt-4o',
      complexity: node.complexity ?? 0.5,
      reason: 'best strategy: top model',
    };
  }

  private assignCheapest(node: AnnotatedNode): NodeProviderAssignment {
    const provider = this.pickProvider(
      'cheapest',
      ['groq', 'gemini', 'openai', 'openrouter', 'together', 'mistral', 'xai', 'anthropic', 'ollama'],
    );
    const defaults = DEFAULTS[provider];
    return {
      nodeId: node.id,
      provider,
      model: defaults?.cheap ?? defaults?.text ?? 'gpt-4o-mini',
      complexity: node.complexity ?? 0.5,
      reason: 'cheapest strategy: cheapest model',
    };
  }

  private assignBalanced(node: AnnotatedNode): NodeProviderAssignment {
    const complexity = node.complexity ?? 0.5;
    const tier =
      complexity < 0.3
        ? 'cheap'
        : complexity >= 0.7
          ? 'strong'
          : 'standard';
    const provider =
      tier === 'cheap'
        ? this.pickProvider(
            'balanced:cheap',
            ['groq', 'gemini', 'openai', 'openrouter', 'together', 'mistral', 'xai', 'anthropic', 'ollama'],
          )
        : tier === 'strong'
          ? this.pickProvider(
              'balanced:strong',
              ['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'xai', 'mistral', 'together', 'ollama'],
            )
          : this.pickProvider(
              'balanced:standard',
              ['openai', 'openrouter', 'anthropic', 'gemini', 'groq', 'mistral', 'xai', 'together', 'ollama'],
            );
    const defaults = DEFAULTS[provider];

    const model =
      tier === 'cheap'
        ? (defaults?.cheap ?? 'gpt-4o-mini')
        : (defaults?.text ?? 'gpt-4o');

    return {
      nodeId: node.id,
      provider,
      model,
      complexity,
      reason: `balanced strategy: complexity ${complexity.toFixed(2)} → ${tier} model`,
    };
  }

  private assignExplicit(
    node: AnnotatedNode,
    assignments: Record<string, ExplicitAssignment>,
  ): NodeProviderAssignment {
    const explicit = assignments[node.id] ?? assignments._default;
    if (explicit) {
      const defaults = DEFAULTS[explicit.provider];
      return {
        nodeId: node.id,
        provider: explicit.provider,
        model: explicit.model ?? defaults?.text ?? 'gpt-4o',
        complexity: node.complexity ?? 0.5,
        reason: 'explicit assignment',
      };
    }
    // No explicit assignment — fall back to balanced
    return this.assignBalanced(node);
  }

  private assignMixed(
    node: AnnotatedNode,
    assignments: Record<string, ExplicitAssignment>,
    fallback: string,
  ): NodeProviderAssignment {
    // Check for explicit assignment first
    if (assignments[node.id] || assignments._default) {
      return this.assignExplicit(node, assignments);
    }

    // Fall back to named strategy
    switch (fallback) {
      case 'best':
        return this.assignBest(node);
      case 'cheapest':
        return this.assignCheapest(node);
      default:
        return this.assignBalanced(node);
    }
  }

  /** Pick a provider from the preferred list, rotating to avoid pinning all nodes to one provider. */
  private pickProvider(bucket: string, preferred?: string[]): string {
    const candidates =
      preferred?.filter((provider) => this.availableProviders.includes(provider))
        ?? this.availableProviders;

    const pool = candidates.length > 0 ? candidates : this.availableProviders;
    if (pool.length === 0) return 'openai';

    const cursor = this.rotation.get(bucket) ?? 0;
    const provider = pool[cursor % pool.length] ?? pool[0] ?? 'openai';
    this.rotation.set(bucket, cursor + 1);
    return provider;
  }
}
