/**
 * @fileoverview MemoryUpdateTool — lets an agent update an existing memory trace.
 *
 * Supports partial updates: the agent may change just the content, just the
 * tags, or both. When the content is changed, the stored embedding is cleared
 * so the background EmbeddingEncoder will re-embed the trace asynchronously
 * on the next pass — preventing stale vector data from contaminating semantic
 * search results.
 *
 * @module memory/tools/MemoryUpdateTool
 */

import type { ITool, ToolExecutionResult, ToolExecutionContext, JSONSchemaObject } from '../../../../core/tools/ITool.js';
import { memoryWriteRefusal } from '../../../learning/toolContext.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import { parseTraceMetadata, sha256Hex } from '../../retrieval/store/tracePersistence.js';
import {
  reachTraces,
  recordToolWrite,
  refusedMemoryWrite,
  stillAsRead,
  TraceMovedError,
  undoToolWrite,
  type MemoryToolWriteBack,
} from './learningWrite.js';
import { memoryToolTurnOf, type MemoryToolTurn } from './scopeContext.js';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input arguments for {@link MemoryUpdateTool}.
 *
 * At least one of `content` or `tags` must be provided alongside `traceId`
 * for an update to have any effect.
 *
 * @property traceId - The ID of the memory trace to update (e.g. `mt_1234_0`).
 * @property content - New text content. When changed, the embedding is cleared.
 * @property tags    - Replacement tag array (overwrites existing tags entirely).
 */
export interface MemoryUpdateInput extends Record<string, any> {
  traceId: string;
  content?: string;
  tags?: string[];
}

/**
 * Output returned by {@link MemoryUpdateTool} on success.
 *
 * @property updated - `true` if a matching, non-deleted trace was found and updated.
 *                     `false` if the trace was not found or was already soft-deleted.
 */
export interface MemoryUpdateOutput {
  updated: boolean;
}

// ---------------------------------------------------------------------------
// MemoryUpdateTool
// ---------------------------------------------------------------------------

/**
 * ITool implementation that applies partial updates to an existing memory
 * trace stored in the agent's SQLite brain database.
 *
 * **Usage:**
 * ```ts
 * const tool = new MemoryUpdateTool(brain);
 * const result = await tool.execute(
 *   { traceId: 'mt_3f2b8c1e-5d4a-4e6f-9b7c-2a1d0e8f6c5b', content: 'Updated content here.' },
 *   context,
 * );
 * // result.output.updated → true
 * ```
 */
export class MemoryUpdateTool implements ITool<MemoryUpdateInput, MemoryUpdateOutput> {
  /** Globally unique tool identifier. */
  readonly id = 'memory-update-v1';

  /** LLM-facing tool name. */
  readonly name = 'memory_update';

  /** Human-readable display name. */
  readonly displayName = 'Update Memory';

  /** LLM-facing description. */
  readonly description =
    'Update an existing memory trace by ID. You can change the content, the tags, or both. ' +
    'If content changes, the stored embedding is cleared and will be re-computed automatically.';

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
        description: 'The unique ID of the memory trace to update.',
      },
      content: {
        type: 'string',
        description: 'New text content for the trace. Clears the stored embedding so it can be re-computed.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement tag array (overwrites the existing tags entirely).',
      },
    },
    required: ['traceId'],
  };

  /**
   * @param brain - The agent's shared SQLite brain database connection.
   * @param writeBack - The facade that made the tool (`Memory.createTools()`), through which a write a learning layer
   *   does not keep is taken back. Without it the tool restores the row itself.
   */
  constructor(
    private readonly brain: Brain,
    private readonly writeBack?: MemoryToolWriteBack,
  ) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * Update a memory trace identified by `traceId`.
   *
   * The method builds a dynamic SET clause based on which optional fields
   * are provided:
   * - `content` provided → set `content = ?`, also set `embedding = NULL`
   *   to signal that the cached vector is stale.
   * - `tags` provided → serialise array as JSON and set `tags = ?`.
   *
   * If neither `content` nor `tags` is specified, the method returns
   * `{ updated: false }` immediately without touching the database.
   *
   * A trace that does not exist or has `deleted = 1` returns `{ updated: false }`.
   *
   * @param args    - Update input (traceId, optional content/tags).
   * @param context - Tool execution context; where it carries the turn's scope ids, the call reaches only a live trace
   *   of the turn's own scopes that the turn's own user filed (another scope's reads as not found, another user's is
   *   refused, `other_user`), and the write runs through the learner session's recorder, writing only while the trace
   *   holds what was read (`conflict` otherwise). Only a freeze stops a write, with a layer or without one (`frozen`).
   * @returns `{ updated }` status, or an error result.
   */
  async execute(
    args: MemoryUpdateInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<MemoryUpdateOutput>> {
    try {
      // Only a freeze stops a memory write, and it is read before anything else.
      const refusal = memoryWriteRefusal(context.sessionData);
      if (refusal) return refusedMemoryWrite(this.name, refusal);

      const { traceId, content, tags } = args;

      // Nothing to update — return false without any DB work.
      if (content === undefined && tags === undefined) {
        return { success: true, output: { updated: false } };
      }

      const turn = memoryToolTurnOf(context);
      if (turn) return await this.updateForTurn(turn, traceId, content, tags);

      const brainId = this.brain.brainId;
      const current = await this.brain.get<{ content: string; tags: string; metadata: string }>(
        `SELECT content, tags, metadata
         FROM memory_traces
         WHERE brain_id = ? AND id = ? AND deleted = 0`,
        [brainId, traceId],
      );

      if (!current) {
        return { success: true, output: { updated: false } };
      }

      const nextContent = content ?? current.content;
      const nextTags = tags !== undefined ? JSON.stringify(tags) : current.tags;
      const nextMetadataObject = parseTraceMetadata(current.metadata);

      if (content !== undefined) {
        nextMetadataObject.content_hash = await sha256Hex(nextContent);
        delete nextMetadataObject.import_hash;
      }

      const nextMetadata = JSON.stringify(nextMetadataObject);
      const sql = content !== undefined
        ? `UPDATE memory_traces
             SET content = ?, tags = ?, metadata = ?, embedding = NULL
             WHERE brain_id = ? AND id = ? AND deleted = 0`
        : `UPDATE memory_traces
             SET content = ?, tags = ?, metadata = ?
             WHERE brain_id = ? AND id = ? AND deleted = 0`;

      const changes = await this.brain.transaction(async (trx) => {
        const info = await trx.run(sql, [nextContent, nextTags, nextMetadata, brainId, traceId]);

        if (info.changes > 0) {
          const rebuild = this.brain.fullTextRebuild();
          await trx.run(rebuild.sql, rebuild.params);
        }

        return info.changes;
      });

      return { success: true, output: { updated: changes > 0 } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * The update where the turn's scope ids are on the call: a live trace of the turn's own scopes that its own user
   * filed, through the learner session's recorder, written only while it holds the content and tags it was read with.
   */
  private async updateForTurn(
    turn: MemoryToolTurn,
    traceId: string,
    content: string | undefined,
    tags: string[] | undefined,
  ): Promise<ToolExecutionResult<MemoryUpdateOutput>> {
    if (!turn.record) return refusedMemoryWrite(this.name, 'no_recorder');
    const { snapshots, otherUser } = await reachTraces(this.brain, [traceId], turn);
    const before = snapshots[0];
    if (!before) {
      return otherUser ? refusedMemoryWrite(this.name, 'other_user') : { success: true, output: { updated: false } };
    }

    const nextContent = content ?? before.content;
    const nextTags = tags !== undefined ? JSON.stringify(tags) : before.tags;
    const nextMetadata = parseTraceMetadata(before.metadata);
    if (content !== undefined) {
      nextMetadata.content_hash = await sha256Hex(nextContent);
      delete nextMetadata.import_hash;
    }
    const unchanged = stillAsRead(before);
    const sql = `UPDATE memory_traces
         SET content = ?, tags = ?, metadata = ?${content !== undefined ? ', embedding = NULL' : ''}
         WHERE brain_id = ? AND id = ?${unchanged.sql}`;
    const brainId = this.brain.brainId;

    return recordToolWrite(
      this.name,
      turn.record,
      {
        kind: 'memory_write',
        actor: `tool:${this.name}`,
        subject: traceId,
        before: { traces: [before] },
        after: { created: [], changed: [{ id: traceId, content: nextContent }], deleted: [] },
        brainId,
        apply: () =>
          this.brain.transaction(async (trx) => {
            const info = await trx.run(sql, [nextContent, nextTags, JSON.stringify(nextMetadata), brainId, traceId, ...unchanged.params]);
            if (info.changes === 0) throw new TraceMovedError(traceId);
            const rebuild = this.brain.fullTextRebuild();
            await trx.run(rebuild.sql, rebuild.params);
          }),
        undo: (_done, reason) => undoToolWrite(this.brain, this.writeBack, { created: [], before: [before] }, reason),
      },
      () => ({ updated: true }),
    );
  }
}
