/**
 * @fileoverview MemoryReflectTool — lets an agent trigger offline memory
 * consolidation on demand.
 *
 * Consolidation is the analogue of slow-wave-sleep memory processing:
 * - **Prune** — soft-delete traces whose Ebbinghaus strength has decayed below threshold.
 * - **Merge** — deduplicate near-identical traces (embedding similarity or hash).
 * - **Strengthen** — record Hebbian co-activation edges from retrieval feedback.
 * - **Derive** — synthesise higher-level insight traces from memory clusters (LLM-backed).
 * - **Compact** — promote old, high-retrieval episodic traces to semantic type.
 * - **Re-index** — rebuild FTS5 index and log the run to `consolidation_log`.
 *
 * The optional `topic` argument is accepted at the contract level but is not
 * yet threaded into the ConsolidationLoop (which currently runs globally).
 * It is reserved for a future topic-scoped consolidation mode.
 *
 * @module memory/tools/MemoryReflectTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '../../../../core/tools/ITool.js';
import { memoryWriteRefusal, readToolLearningContext } from '../../../learning/toolContext.js';
import type { ConsolidationLoop } from '../../pipeline/consolidation/ConsolidationLoop.js';
import type { ConsolidationResult } from '../facade/types.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import { refusedMemoryWrite } from './learningWrite.js';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * Input arguments for {@link MemoryReflectTool}.
 *
 * @property topic - Optional hint for the consolidation run. Currently reserved
 *                   for future topic-scoped consolidation; ignored at runtime.
 */
export interface MemoryReflectInput extends Record<string, any> {
  topic?: string;
}

// ---------------------------------------------------------------------------
// MemoryReflectTool
// ---------------------------------------------------------------------------

/**
 * ITool implementation that triggers one full memory consolidation cycle via
 * {@link ConsolidationLoop.run()}.
 *
 * **Usage:**
 * ```ts
 * const tool = new MemoryReflectTool(brain, consolidationLoop);
 * const result = await tool.execute({}, context);
 * // result.output → { pruned: 3, merged: 1, derived: 0, compacted: 2, durationMs: 42 }
 * ```
 */
export class MemoryReflectTool implements ITool<MemoryReflectInput, ConsolidationResult> {
  /** Globally unique tool identifier. */
  readonly id = 'memory-reflect-v1';

  /** LLM-facing tool name. */
  readonly name = 'memory_reflect';

  /** Human-readable display name. */
  readonly displayName = 'Reflect on Memory';

  /**
   * Description shown to the LLM. The consolidation steps are described
   * explicitly so the model understands what "reflect" means operationally.
   */
  readonly description =
    'Trigger memory consolidation — prune weak memories, merge duplicates, derive insights from patterns. ' +
    'This runs an offline slow-wave-sleep analogue: decayed traces are pruned, near-identical traces are ' +
    'merged, Hebbian co-activation edges are recorded, insights are derived from clusters, and old ' +
    'high-retrieval episodic traces are promoted to semantic type. Returns consolidation statistics.';

  /** Logical category for discovery and grouping. */
  readonly category = 'memory';

  /**
   * Consolidation writes to the database (pruning, merging, inserting insights).
   * Mark as having side effects so callers may request confirmation if needed.
   */
  readonly hasSideEffects = true;

  /** JSON schema for input validation and LLM tool-call construction. */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Optional topic hint for the consolidation run. Reserved for future topic-scoped consolidation.',
      },
    },
  };

  /**
   * @param brain         - The agent's shared SQLite brain database connection.
   *                        Accepted for symmetry with other memory tools and for
   *                        future direct consolidation calls.
   * @param consolidation - The {@link ConsolidationLoop} instance to invoke.
   */
  constructor(
    private readonly brain: Brain,
    private readonly consolidation: ConsolidationLoop,
  ) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * The refusal a consolidation meets whatever a human would answer, read before the tool orchestrator's approval gate
   * (`ITool.refusalBeforeApproval`), so no one is asked to approve a run that cannot act: a freeze, then any call that
   * carries a learning layer's session data (`withdrawn`). `execute` refuses the same call itself, in the same order.
   *
   * @param _args - The call's arguments.
   * @param context - The call's context.
   * @returns The refusal, or `undefined` when the call may run.
   */
  refusalBeforeApproval(_args: Record<string, any>, context: ToolExecutionContext): ToolExecutionResult<ConsolidationResult> | undefined {
    const refusal = memoryWriteRefusal(context.sessionData);
    if (refusal) return refusedMemoryWrite(this.name, refusal);
    return readToolLearningContext(context.sessionData) ? refusedMemoryWrite(this.name, 'withdrawn') : undefined;
  }

  /**
   * Run one full consolidation cycle and return the statistics.
   *
   * If a consolidation cycle is already in progress (mutex guard in
   * {@link ConsolidationLoop}), `run()` returns immediately with zero counts —
   * this is surfaced as a successful result with all-zero statistics.
   *
   * @param _args   - Reflect input (optional topic hint, currently unused).
   * @param context - Tool execution context: a freeze refuses the call (`frozen`), and so does a call that carries
   *   `sessionData.learning` (`withdrawn`), since consolidation merges and derives across every scope of the brain.
   * @returns {@link ConsolidationResult} on success, or an error result.
   */
  async execute(
    _args: MemoryReflectInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ConsolidationResult>> {
    // Only a freeze stops a memory write; consolidation then does not run where a learning layer exists at all.
    const refusal = memoryWriteRefusal(context.sessionData);
    if (refusal) return refusedMemoryWrite(this.name, refusal);
    if (readToolLearningContext(context.sessionData)) return refusedMemoryWrite(this.name, 'withdrawn');
    try {
      const result = await this.consolidation.run();
      return { success: true, output: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
