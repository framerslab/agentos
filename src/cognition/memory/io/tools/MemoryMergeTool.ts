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
import { memoryWriteRefusal } from '../../../learning/toolContext.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import {
  parseTraceMetadata,
  readPersistedDecayState,
  sha256Hex,
  withPersistedDecayState,
  type TraceSnapshot,
} from '../../retrieval/store/tracePersistence.js';
import {
  dropGraphCopies,
  reachTraces,
  recordToolWrite,
  refusedMemoryWrite,
  stillAsRead,
  TraceMovedError,
  undoToolWrite,
  type MemoryToolWriteBack,
} from './learningWrite.js';
import { memoryToolTurnOf } from './scopeContext.js';

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

/** A snapshot as the merge's row shape. */
function rowOfSnapshot(snapshot: TraceSnapshot): TraceRow {
  return {
    id: snapshot.id,
    content: snapshot.content,
    retrieval_count: snapshot.retrievalCount,
    tags: snapshot.tags,
    metadata: snapshot.metadata,
    last_accessed: snapshot.lastAccessed,
    created_at: snapshot.createdAt,
  };
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
   * @param writeBack - The facade that made the tool (`Memory.createTools()`): the merged-away traces'
   *   knowledge-graph copies are deleted through it, and a merge a learning layer does not keep is taken back through
   *   it. Without it the tool restores the rows itself.
   */
  constructor(
    private readonly brain: Brain,
    private readonly writeBack?: MemoryToolWriteBack,
  ) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * Merge the specified traces into one survivor.
   *
   * Steps:
   * 1. Validate that at least 2 trace IDs were supplied.
   * 2. Load all matching, non-deleted traces from the database.
   * 3. Pick survivor by highest `retrieval_count`; on a tie, the first of `traceIds`.
   * 4. Compute merged content (provided or concatenated).
   * 5. Union all tags, deduplicate.
   * 6. Update survivor: new content, cleared embedding, unioned tags.
   * 7. Soft-delete all non-survivor traces, and their knowledge-graph copies through the facade that made the tool.
   *
   * @param args    - Merge input (traceIds, optional mergedContent).
   * @param context - Tool execution context; where it carries the turn's scope ids, every trace the call names must be
   *   one the turn reaches: a live trace of the turn's own scopes that the turn's own user filed (another scope's reads
   *   as not found; one another user filed refuses the whole merge, `other_user`). The merge then runs through the
   *   learner session's recorder, writing each row only while it holds what was read (`conflict` otherwise). Only a
   *   freeze stops a merge, with a layer or without one (`frozen`).
   * @returns `{ survivorId, deletedIds }` on success, or an error result.
   */
  async execute(
    args: MemoryMergeInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<MemoryMergeOutput>> {
    try {
      // Only a freeze stops a memory write, and it is read before anything else.
      const refusal = memoryWriteRefusal(context.sessionData);
      if (refusal) return refusedMemoryWrite(this.name, refusal);

      const { traceIds, mergedContent } = args;

      if (!traceIds || traceIds.length < 2) {
        return {
          success: false,
          error: 'traceIds must contain at least 2 trace IDs.',
        };
      }

      const turn = memoryToolTurnOf(context);
      if (turn && !turn.record) return refusedMemoryWrite(this.name, 'no_recorder');

      // Load all matching active traces, in the order the call names them: a tie in retrieval count goes to the first.
      const brainId = this.brain.brainId;
      const placeholders = traceIds.map(() => '?').join(', ');
      const order = new Map<string, number>();
      traceIds.forEach((id, index) => {
        if (!order.has(id)) order.set(id, index);
      });
      let rows = (
        await this.brain.all<TraceRow>(
          `SELECT id, content, retrieval_count, tags, metadata, last_accessed, created_at
           FROM memory_traces
           WHERE brain_id = ? AND id IN (${placeholders}) AND deleted = 0`,
          [brainId, ...traceIds],
        )
      ).sort((a, b) => order.get(a.id)! - order.get(b.id)!);

      // With the turn's scope ids on the call, only the traces the turn reaches count, each as it was read; one
      // another user filed refuses the merge.
      let before: TraceSnapshot[] = [];
      if (turn) {
        const reached = await reachTraces(this.brain, rows.map((row) => row.id), turn);
        if (reached.otherUser) return refusedMemoryWrite(this.name, 'other_user');
        before = reached.snapshots;
        rows = before.map(rowOfSnapshot);
      }

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

      const merged = rows.filter((row) => row.id !== survivor.id).map((row) => row.id);
      // With a turn each row is written only while it holds what was read; without one, as before.
      const guardOf = (id: string): { sql: string; params: unknown[] } => {
        const snapshot = before.find((s) => s.id === id);
        return turn && snapshot ? stillAsRead(snapshot) : { sql: '', params: [] };
      };

      // Update survivor: new content, cleared embedding, unioned tags; soft-delete the others.
      const merge = async (): Promise<MemoryMergeOutput> => {
        await this.brain.transaction(async (trx) => {
          const survivorGuard = guardOf(survivor.id);
          const updated = await trx.run(
            `UPDATE memory_traces
             SET content = ?, embedding = NULL, tags = ?, metadata = ?, retrieval_count = ?, last_accessed = ?
             WHERE brain_id = ? AND id = ?${survivorGuard.sql}`,
            [finalContent, finalTags, mergedMetadata, mergedRetrievalCount, mergedLastAccessed, brainId, survivor.id, ...survivorGuard.params],
          );
          if (turn && updated.changes === 0) throw new TraceMovedError(survivor.id);

          for (const id of merged) {
            const guard = guardOf(id);
            const gone = await trx.run(
              `UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?${guard.sql}`,
              [brainId, id, ...guard.params],
            );
            if (turn && gone.changes === 0) throw new TraceMovedError(id);
          }

          const rebuild = this.brain.fullTextRebuild();
          await trx.run(rebuild.sql, rebuild.params);
        });
        await dropGraphCopies(this.writeBack, merged);
        return { survivorId: survivor.id, deletedIds: [...merged] };
      };

      if (!turn?.record) {
        return { success: true, output: await merge() };
      }
      return await recordToolWrite(
        this.name,
        turn.record,
        {
          kind: 'memory_write',
          actor: `tool:${this.name}`,
          subject: survivor.id,
          before: { traces: before },
          after: { created: [], changed: [{ id: survivor.id, content: finalContent }], deleted: [...merged] },
          brainId,
          apply: merge,
          undo: (_output, reason) => undoToolWrite(this.brain, this.writeBack, { created: [], before }, reason),
        },
        (output) => output,
      );
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
