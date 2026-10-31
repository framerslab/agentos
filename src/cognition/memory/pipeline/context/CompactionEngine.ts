/**
 * CompactionEngine — Strategy dispatcher for context window compaction.
 *
 * Selects and executes the appropriate compaction strategy based on config.
 * Manages strategy lifecycle and provides a unified interface for the
 * ContextWindowManager.
 */

import type { MemoryObserver } from '../observation/MemoryObserver.js';
import type { MemoryReflector } from '../observation/MemoryReflector.js';
import type {
  CompactionInput,
  CompactionResult,
  CompactionStrategy,
  ICompactionStrategy,
  InfiniteContextConfig,
} from './types.js';
import { HierarchicalStrategy } from './strategies/HierarchicalStrategy.js';
import { HybridStrategy } from './strategies/HybridStrategy.js';
import { SlidingSummaryStrategy } from './strategies/SlidingSummaryStrategy.js';

export class CompactionEngine {
  private strategies: Map<CompactionStrategy, ICompactionStrategy> = new Map();

  /**
   * @param llmInvoker - Writes the summaries. Without one, each strategy writes
   *   an extractive summary from the conversation itself.
   * @param observer - For the hybrid strategy's observation notes.
   * @param reflector - For the hybrid strategy's memory traces.
   */
  constructor(
    llmInvoker?: (prompt: string) => Promise<string>,
    observer?: MemoryObserver,
    reflector?: MemoryReflector,
  ) {
    this.strategies.set('sliding', new SlidingSummaryStrategy(llmInvoker));
    this.strategies.set(
      'hierarchical',
      new HierarchicalStrategy(llmInvoker),
    );
    this.strategies.set(
      'hybrid',
      new HybridStrategy(llmInvoker, observer, reflector),
    );
  }

  /** Run compaction using the configured strategy. */
  async compact(
    input: CompactionInput,
    config: InfiniteContextConfig,
  ): Promise<CompactionResult> {
    const strategy = this.strategies.get(config.strategy);
    if (!strategy) {
      throw new Error(`Unknown compaction strategy: ${config.strategy}`);
    }
    return strategy.compact(input, config);
  }

  /** Get a specific strategy instance. */
  getStrategy(name: CompactionStrategy): ICompactionStrategy | undefined {
    return this.strategies.get(name);
  }

  /** List available strategy names. */
  getAvailableStrategies(): CompactionStrategy[] {
    return Array.from(this.strategies.keys());
  }
}
