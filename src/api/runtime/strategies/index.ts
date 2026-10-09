/**
 * @file index.ts
 * Strategy compiler dispatcher for the Agency API.
 *
 * Maps an {@link AgencyStrategy} discriminant to the concrete compiler that
 * produces a {@link CompiledStrategy}. Supports sequential, parallel, debate,
 * review-loop, hierarchical, and graph strategies.
 *
 * ## Adaptive mode
 *
 * When `adaptive` mode is enabled on a non-hierarchical strategy, the dispatcher
 * wraps it with an implicit hierarchical manager that may override the default
 * strategy at runtime. This works by:
 *
 * 1. Appending strategy-awareness instructions to the manager prompt.
 * 2. Setting `adaptive: false` on the inner call to prevent infinite recursion.
 * 3. Delegating to `compileHierarchical()` which creates delegation tools.
 *
 * The adaptive wrapper is transparent to the caller -- it still receives a
 * standard {@link CompiledStrategy} with `execute` and `stream` methods.
 *
 * @see {@link compileStrategy} -- the main entry point for strategy compilation.
 * @see {@link agency} -- the factory that calls compileStrategy during construction.
 */
import type {
  AgencyStrategy,
  AgencyOptions,
  CompiledStrategy,
  Agent,
  BaseAgentConfig,
} from '../types.js';
import type { SeatedRoster } from '../pool/seating.js';
import { compileSequential } from './sequential.js';
import { compileParallel } from './parallel.js';
import { compileDebate } from './debate.js';
import { compileReviewLoop } from './review-loop.js';
import { compileHierarchical } from './hierarchical.js';
import { compileGraph } from './graph.js';

/**
 * Compile an orchestration strategy into an executable {@link CompiledStrategy}.
 *
 * When `agencyConfig.adaptive` is `true` and the requested strategy is not
 * already `"hierarchical"`, the compiled strategy is wrapped in an adaptive
 * hierarchical manager that may override the default strategy at runtime
 * based on task complexity signals.
 *
 * @param strategy - Strategy discriminant (e.g. `"sequential"`, `"parallel"`).
 * @param agents - Named roster of agent configs or pre-built `Agent` instances.
 * @param agencyConfig - Full agency-level configuration providing fallback values.
 * @param seating - The call's seating, in an agency with a pool or a panel;
 *   undefined at the construction-time compile and in any other agency.
 * @returns A compiled strategy with `execute` and `stream` methods.
 * @throws {Error} When the requested strategy is not yet implemented (e.g. a
 *         future strategy discriminant that has been added to `AgencyStrategy`
 *         but not yet wired here).
 *
 * @example
 * ```ts
 * const strategy = compileStrategy('sequential', agents, agencyConfig);
 * const result = await strategy.execute('Summarise AI research.');
 * ```
 */
export function compileStrategy(
  strategy: AgencyStrategy,
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
  seating?: SeatedRoster,
): CompiledStrategy {
  // When adaptive mode is enabled on non-hierarchical strategies, wrap with
  // a manager that can override the strategy at runtime. Hierarchical is
  // excluded because it IS the manager pattern -- wrapping it again would
  // create a pointless double-manager layer.
  if (agencyConfig.adaptive && strategy !== 'hierarchical') {
    return compileAdaptiveWrapper(strategy, agents, agencyConfig, seating?.mask);
  }

  return compileStrategyCore(strategy, agents, agencyConfig, seating);
}

/**
 * Core strategy compiler without adaptive wrapping.
 *
 * Dispatches on the strategy discriminant to the appropriate concrete compiler.
 * Each compiler returns a {@link CompiledStrategy} with consistent `execute`
 * and `stream` method signatures.
 *
 * @param strategy - Strategy discriminant.
 * @param agents - Named agent roster.
 * @param agencyConfig - Agency-level configuration.
 * @param seating - The call's seating, when one ran.
 * @returns A compiled strategy.
 * @throws {Error} When the strategy is not recognised.
 * @internal
 */
function compileStrategyCore(
  strategy: AgencyStrategy,
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
  seating?: SeatedRoster,
): CompiledStrategy {
  switch (strategy) {
    case 'sequential':
      return compileSequential(agents, agencyConfig);
    case 'parallel':
      return compileParallel(agents, agencyConfig);
    case 'debate':
      return compileDebate(agents, agencyConfig);
    case 'review-loop':
      return compileReviewLoop(agents, agencyConfig);
    case 'hierarchical':
      // The call's mask reaches the delegate and spawn tools; undefined at
      // the construction-time compile and in an agency without a pool.
      return compileHierarchical(agents, agencyConfig, seating?.mask);
    case 'graph':
      return compileGraph(agents, agencyConfig);
    default:
      throw new Error(`Strategy '${strategy}' not yet implemented`);
  }
}

/**
 * Wraps a non-hierarchical strategy in an adaptive hierarchical manager.
 *
 * The manager prompt declares the default strategy and instructs the manager
 * that it may override strategy selection if the task clearly does not require
 * all agents. In practice, the manager delegates to the sub-agents via tools
 * just like the hierarchical strategy, but with the additional context of the
 * original intended strategy.
 *
 * ## Recursion prevention
 *
 * `adaptive: false` is set on the inner config to prevent the hierarchical
 * compiler from re-entering the adaptive wrapper, which would cause infinite
 * recursion.
 *
 * @param defaultStrategy - The user-declared default strategy (e.g. `"sequential"`).
 * @param agents - Named agent roster.
 * @param agencyConfig - Agency-level configuration.
 * @param mask - The call's error mask in a pooled agency, for the delegate tools.
 * @returns A compiled hierarchical strategy with adaptive instructions.
 * @internal
 */
function compileAdaptiveWrapper(
  defaultStrategy: AgencyStrategy,
  agents: Record<string, BaseAgentConfig | Agent>,
  agencyConfig: AgencyOptions,
  mask?: (error: unknown) => unknown,
): CompiledStrategy {
  const adaptiveInstructions =
    (agencyConfig.instructions ? agencyConfig.instructions + '\n\n' : '') +
    `Your default strategy is "${defaultStrategy}". You may override it if the task clearly doesn't need all agents. ` +
    `Use your judgment to decide whether to engage all team members or delegate to a subset.`;

  const adaptiveConfig: AgencyOptions = {
    ...agencyConfig,
    instructions: adaptiveInstructions,
    // Disable adaptive on the inner call to prevent infinite recursion.
    adaptive: false,
  };

  return compileHierarchical(agents, adaptiveConfig, mask);
}

export { compileSequential } from './sequential.js';
export { compileParallel } from './parallel.js';
export { compileDebate } from './debate.js';
export { compileReviewLoop } from './review-loop.js';
export { compileHierarchical } from './hierarchical.js';
export { compileGraph } from './graph.js';
export { isAgent, mergeDefaults, resolveAgent, checkBeforeAgent } from './shared.js';
export { compileAgencyToGraph, mapGraphResultToAgencyResult, mapGraphEventToAgencyEvent } from './graphCompiler.js';
export { agentGraph, AgentGraphBuilder } from './agentGraphBuilder.js';
export type { AgentNodeConfig } from './agentGraphBuilder.js';
