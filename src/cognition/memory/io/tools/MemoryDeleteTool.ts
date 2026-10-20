/**
 * @fileoverview MemoryDeleteTool — lets an agent soft-delete a memory trace.
 *
 * Deletion is always a soft-delete: the row in `memory_traces` is kept intact
 * but its `deleted` flag is set to `1`. This preserves the audit trail and
 * allows the consolidation engine to later log or compact the removal.
 *
 * The optional `reason` argument is currently captured in the tool contract
 * but not stored in the database; it is reserved for a future `deleted_reason`
 * column when schema migration tooling is in place.
 *
 * @module memory/tools/MemoryDeleteTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '../../../../core/tools/ITool.js';
import type { Brain } from '../../retrieval/store/Brain.js';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input arguments for {@link MemoryDeleteTool}.
 *
 * @property traceId - ID of the trace to soft-delete.
 * @property reason  - Optional human-readable explanation for the deletion.
 *                     Useful for agents to self-document their pruning decisions.
 */
export interface MemoryDeleteInput extends Record<string, any> {
  traceId: string;
  reason?: string;
}

/**
 * Output returned by {@link MemoryDeleteTool} on success.
 *
 * @property deleted - `true` if the trace was found and marked deleted.
 *                     `false` if no active trace matched the given `traceId`.
 */
export interface MemoryDeleteOutput {
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// MemoryDeleteTool
// ---------------------------------------------------------------------------

/**
 * ITool implementation that soft-deletes a memory trace from the agent's
 * SQLite brain database.
 *
 * **Usage:**
 * ```ts
 * const tool = new MemoryDeleteTool(brain);
 * const result = await tool.execute(
 *   { traceId: 'mt_3f2b8c1e-5d4a-4e6f-9b7c-2a1d0e8f6c5b', reason: 'Information is outdated.' },
 *   context,
 * );
 * // result.output.deleted → true
 * ```
 */
export class MemoryDeleteTool implements ITool<MemoryDeleteInput, MemoryDeleteOutput> {
  /** Globally unique tool identifier. */
  readonly id = 'memory-delete-v1';

  /** LLM-facing tool name. */
  readonly name = 'memory_delete';

  /** Human-readable display name. */
  readonly displayName = 'Delete Memory';

  /** LLM-facing description. */
  readonly description =
    'Soft-delete a memory trace by ID. The trace is not physically removed — ' +
    'it is flagged as deleted and excluded from future searches and consolidation. ' +
    'Use when a fact is outdated, incorrect, or no longer relevant.';

  /** Logical category for discovery and grouping. */
  readonly category = 'memory';

  /** This tool writes to the database. */
  readonly hasSideEffects = true;

  /** JSON schema for input validation and LLM tool-call construction. */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      traceId: {
        type: 'string',
        description: 'The unique ID of the memory trace to delete.',
      },
      reason: {
        type: 'string',
        description: 'Optional human-readable reason for deleting this memory.',
      },
    },
    required: ['traceId'],
  };

  /**
   * @param brain - The agent's shared SQLite brain database connection.
   */
  constructor(private readonly brain: Brain) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * Set `deleted = 1` on the memory trace matching `traceId`.
   *
   * The WHERE clause filters to `deleted = 0` so that attempting to
   * delete an already-deleted trace returns `{ deleted: false }` rather
   * than silently succeeding — this gives callers accurate feedback.
   *
   * @param args     - Delete input (traceId, optional reason).
   * @param _context - Tool execution context (not used by this tool).
   * @returns `{ deleted }` status, or an error result.
   */
  async execute(
    args: MemoryDeleteInput,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<MemoryDeleteOutput>> {
    try {
      const info = await this.brain.run(
        `UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ? AND deleted = 0`,
        [this.brain.brainId, args.traceId],
      );

      return { success: true, output: { deleted: info.changes > 0 } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
