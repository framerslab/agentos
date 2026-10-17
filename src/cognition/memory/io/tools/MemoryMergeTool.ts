/**
 * @fileoverview MemoryMergeTool — lets an agent merge multiple memory traces
 * into a single, consolidated trace.
 *
 * The merge process:
 * 1. Load all specified traces from the database.
 * 2. Select the survivor — the trace with the highest `retrieval_count`
 *    (most-frequently accessed, i.e. most valuable). Ties broken by taking
 *    the first trace in the provided `traceIds` array.
 * 3. Determine merged content — use `mergedContent` if the agent supplied it,
 *    otherwise concatenate all trace contents with ` | ` as separator.
 * 4. Update the survivor's content, clear its embedding (stale after merge),
 *    and union the tags from all merged traces (deduplicated).
 * 5. Soft-delete all non-survivor traces.
 *
 * @module memory/tools/MemoryMergeTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '../../../../core/tools/ITool.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import {
  parseTraceMetadata,
  readPersistedDecayState,
  sha256Hex,
  withPersistedDecayState,
} from '../../retrieval/store/tracePersistence.js';

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

/** Minimal column set needed for the merge operation. */
interface TraceRow {
  id: string;
  content: string;
  retrieval_count: number;
  tags: string;
  metadata: string;
  last_accessed: number | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input arguments for {@link MemoryMergeTool}.
 *
 * @property traceIds      - Array of trace IDs to merge. Must contain at least 2 IDs.
 * @property mergedContent - Optional pre-composed merged content. If omitted, the
 *                           contents of all traces are concatenated with ` | `.
 */
export interface MemoryMergeInput extends Record<string, any> {
  traceIds: string[];
  mergedContent?: string;
}

/**
 * Output returned by {@link MemoryMergeTool} on success.
 *
 * @property survivorId  - The ID of the trace that survived the merge.
 * @property deletedIds  - IDs of all traces that were soft-deleted.
 */
export interface MemoryMergeOutput {
  survivorId: string;
  deletedIds: string[];
}

// ---------------------------------------------------------------------------
// MemoryMergeTool
// ---------------------------------------------------------------------------

/**
 * ITool implementation that merges multiple memory traces into one.
 *
 * **Usage:**
 * ```ts
 * const tool = new MemoryMergeTool(brain);
 * const result = await tool.execute(
 *   {
 *     traceIds: ['mt_1_0', 'mt_2_0', 'mt_3_0'],
 *     mergedContent: 'Consolidated insight from three related observations.',
 *   },
 *   context,
 * );
 * // result.output → { survivorId: 'mt_1_0', deletedIds: ['mt_2_0', 'mt_3_0'] }
 * ```
 */
export class MemoryMergeTool implements ITool<MemoryMergeInput, MemoryMergeOutput> {
  /** Globally unique tool identifier. */
  readonly id = 'memory-merge-v1';

  /** LLM-facing tool name. */
  readonly name = 'memory_merge';

  /** Human-readable display name. */
  readonly displayName = 'Merge Memories';

  /** LLM-facing description. */
  readonly description =
    'Merge two or more memory traces into a single consolidated trace. ' +
    'The trace with the highest retrieval count survives; others are soft-deleted. ' +
    'Optionally provide pre-composed merged content; otherwise, contents are concatenated.';

  /** Logical category for discovery and grouping. */
  readonly category = 'memory';

  /** This tool writes to the database. */
  readonly hasSideEffects = true;

  /** JSON schema for input validation and LLM tool-call construction. */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      traceIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        description: 'Array of trace IDs to merge. Must contain at least 2 IDs.',
      },
      mergedContent: {
        type: 'string',
        description:
          'Optional pre-composed merged content. If omitted, trace contents are joined with " | ".',
      },
    },
    required: ['traceIds'],
  };

  /**
   * @param brain - The agent's shared SQLite brain database connection.
   */
  constructor(private readonly brain: Brain) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * Merge the specified traces into one survivor.
   *
   * Steps:
   * 1. Validate that at least 2 trace IDs were supplied.
   * 2. Load all matching, non-deleted traces from the database.
   * 3. Pick survivor by highest `retrieval_count`; fallback to first found.
   * 4. Compute merged content (provided or concatenated).
   * 5. Union all tags, deduplicate.
   * 6. Update survivor: new content, cleared embedding, unioned tags.
   * 7. Soft-delete all non-survivor traces.
   *
   * @param args     - Merge input (traceIds, optional mergedContent).
   * @param _context - Tool execution context (not used by this tool).
   * @returns `{ survivorId, deletedIds }` on success, or an error result.
   */
  async execute(
    args: MemoryMergeInput,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<MemoryMergeOutput>> {
    try {
      const { traceIds, mergedContent } = args;

      if (!traceIds || traceIds.length < 2) {
        return {
          success: false,
          error: 'traceIds must contain at least 2 trace IDs.',
        };
      }

      // Load all matching active traces.
      const brainId = this.brain.brainId;
      const placeholders = traceIds.map(() => '?').join(', ');
      const rows = await this.brain.all<TraceRow>(
        `SELECT id, content, retrieval_count, tags, metadata, last_accessed, created_at
         FROM memory_traces
         WHERE brain_id = ? AND id IN (${placeholders}) AND deleted = 0`,
        [brainId, ...traceIds],
      );

      if (rows.length < 2) {
        return {
          success: false,
          error: `Found only ${rows.length} active trace(s) for the provided IDs. Need at least 2.`,
        };
      }

      // Pick survivor — trace with highest retrieval_count.
      // Stable sort: keeps original order for equal counts so the first traceId wins.
      const sorted = [...rows].sort((a, b) => b.retrieval_count - a.retrieval_count);
      const survivor = sorted[0]!;

      // Determine merged content.
      const finalContent =
        mergedContent !== undefined && mergedContent.trim().length > 0
          ? mergedContent
          : rows.map((r) => r.content).join(' | ');

      // Union tags from all traces (deduplicated).
      const allTags = new Set<string>();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tags) as string[];
          for (const tag of parsed) allTags.add(tag);
        } catch {
          // Malformed JSON tag — skip gracefully.
        }
      }
      const finalTags = JSON.stringify([...allTags]);
      const survivorMetadata = parseTraceMetadata(survivor.metadata);
      survivorMetadata.content_hash = await sha256Hex(finalContent);
      delete survivorMetadata.import_hash;

      const mergedDecay = rows.map((row) =>
        readPersistedDecayState(parseTraceMetadata(row.metadata), row.retrieval_count),
      );
      const mergedMetadata = JSON.stringify(
        withPersistedDecayState(survivorMetadata, {
          stability: Math.max(...mergedDecay.map((state) => state.stability)),
          accessCount: mergedDecay.reduce((sum, state) => sum + state.accessCount, 0),
          reinforcementInterval: Math.max(
            ...mergedDecay.map((state) => state.reinforcementInterval),
          ),
          ...(mergedDecay.some((state) => state.nextReinforcementAt !== undefined)
            ? {
                nextReinforcementAt: Math.max(
                  ...mergedDecay.map((state) => state.nextReinforcementAt ?? 0),
                ),
              }
            : {}),
        }),
      );
      const mergedRetrievalCount = rows.reduce((sum, row) => sum + row.retrieval_count, 0);
      const mergedLastAccessed = Math.max(
        ...rows.map((row) => row.last_accessed ?? row.created_at),
      );

      // Update survivor: new content, cleared embedding, unioned tags.
      const deletedIds: string[] = [];

      await this.brain.transaction(async (trx) => {
        await trx.run(
          `UPDATE memory_traces
           SET content = ?, embedding = NULL, tags = ?, metadata = ?, retrieval_count = ?, last_accessed = ?
           WHERE brain_id = ? AND id = ?`,
          [finalContent, finalTags, mergedMetadata, mergedRetrievalCount, mergedLastAccessed, brainId, survivor.id],
        );

        // Soft-delete all non-survivors.
        for (const row of rows) {
          if (row.id !== survivor.id) {
            await trx.run(
              `UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?`,
              [brainId, row.id],
            );
            deletedIds.push(row.id);
          }
        }

        const rebuild = this.brain.fullTextRebuild();
        await trx.run(rebuild.sql, rebuild.params);
      });
      return {
        success: true,
        output: { survivorId: survivor.id, deletedIds },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
