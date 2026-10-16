/**
 * @fileoverview MemoryAddTool — lets an agent store a new memory trace.
 *
 * The agent calls this tool to remember important facts, decisions, or
 * observations. Each invocation inserts a fresh row into `memory_traces`
 * with strength 1.0 (full encoding strength at creation time).
 *
 * ID format: `mt_<uuid>`, a v4 UUID, as the Memory facade names its traces.
 * Several brains can share a database, each with its own processes; an id
 * unique only within one process could name another brain's row, and the
 * full-text sync after the insert finds the new row by its id.
 *
 * @module memory/tools/MemoryAddTool
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../../../core/tools/ITool.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import type { MemoryScope, MemoryType } from '../../core/types.js';
import { uuid } from '../../core/util/crossPlatformCrypto.js';
import { buildInitialTraceMetadata, sha256Hex } from '../../retrieval/store/tracePersistence.js';
import { resolveMemoryToolScopeId } from './scopeContext.js';

/** The memory types the tool stores, as its input schema lists them. */
const MEMORY_TYPES: readonly MemoryType[] = ['episodic', 'semantic', 'procedural', 'prospective', 'relational'];

/** The scopes the tool stores into, as its input schema lists them. */
const MEMORY_SCOPES: readonly MemoryScope[] = ['thread', 'user', 'persona', 'organization'];

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input arguments for {@link MemoryAddTool}.
 *
 * @property content - The text content of the memory to store.
 * @property type    - Tulving memory type (episodic, semantic, procedural, prospective, relational). Defaults to 'episodic'.
 * @property scope   - Visibility scope (thread, user, persona, organization). Defaults to 'user'.
 * @property tags    - Optional array of free-form tag strings for filtering.
 */
export interface MemoryAddInput extends Record<string, any> {
  content: string;
  type?: string;
  scope?: string;
  tags?: string[];
}

/**
 * Output returned by {@link MemoryAddTool} on success.
 *
 * @property traceId - The unique ID of the newly stored memory trace.
 */
export interface MemoryAddOutput {
  traceId: string;
}

// ---------------------------------------------------------------------------
// MemoryAddTool
// ---------------------------------------------------------------------------

/**
 * ITool implementation that stores a new memory trace in the agent's
 * SQLite brain database.
 *
 * **Usage:**
 * ```ts
 * const tool = new MemoryAddTool(brain);
 * const result = await tool.execute(
 *   { content: 'User prefers dark mode.', tags: ['preference', 'ui'] },
 *   context,
 * );
 * // result.output.traceId → 'mt_3f2b8c1e-5d4a-4e6f-9b7c-2a1d0e8f6c5b'
 * ```
 */
export class MemoryAddTool implements ITool<MemoryAddInput, MemoryAddOutput> {
  /** Globally unique tool identifier. */
  readonly id = 'memory-add-v1';

  /** LLM-facing tool name (snake_case, as the LLM will call it). */
  readonly name = 'memory_add';

  /** Human-readable display name for UIs and logs. */
  readonly displayName = 'Add Memory';

  /**
   * Description shown to the LLM when deciding which tool to invoke.
   * Must be comprehensive enough for the model to understand when to call this.
   */
  readonly description =
    'Store a new memory trace. The agent calls this to remember important facts, decisions, or observations.';

  /** Logical category for discovery and grouping. */
  readonly category = 'memory';

  /**
   * This tool writes to the database.
   * Callers may request confirmation before execution when `hasSideEffects = true`.
   */
  readonly hasSideEffects = true;

  /**
   * JSON schema for input validation and LLM tool-call construction.
   * All optional fields default gracefully inside `execute()`.
   */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The text content of the memory to store.',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Tulving memory type. Defaults to "episodic".',
      },
      scope: {
        type: 'string',
        enum: [...MEMORY_SCOPES],
        description: 'Visibility scope of the trace. Defaults to "user".',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional free-form tags for filtering and retrieval.',
      },
    },
    required: ['content'],
  };

  /**
   * @param brain - The agent's shared SQLite brain database connection.
   */
  constructor(private readonly brain: Brain) {}

  // ---------------------------------------------------------------------------
  // execute
  // ---------------------------------------------------------------------------

  /**
   * Insert a new memory trace row into `memory_traces`.
   *
   * Defaults applied when optional fields are absent:
   * - `type`  → `'episodic'`
   * - `scope` → `'user'`
   * - `tags`  → `[]`
   *
   * The trace is created with `strength = 1.0` (maximum encoding strength)
   * and `deleted = 0` (active). No embedding is computed here — the background
   * EmbeddingEncoder will embed it asynchronously.
   *
   * A `type` or `scope` outside the input schema's lists is refused with an
   * error result and nothing is stored. A caller that runs the tool without
   * checking its arguments against the schema gets the same answer.
   *
   * @param args    - Memory add input (content, optional type/scope/tags).
   * @param context - Tool execution context used to resolve the scope ID.
   * @returns `{ traceId }` on success, or an error result.
   */
  async execute(
    args: MemoryAddInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<MemoryAddOutput>> {
    try {
      const type = args.type ?? 'episodic';
      const scope = args.scope ?? 'user';
      if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
        return { success: false, error: `type must be one of: ${MEMORY_TYPES.join(', ')}` };
      }
      if (!(MEMORY_SCOPES as readonly string[]).includes(scope)) {
        return { success: false, error: `scope must be one of: ${MEMORY_SCOPES.join(', ')}` };
      }

      const now = Date.now();
      const traceId = `mt_${uuid()}`;
      const scopeId = resolveMemoryToolScopeId(scope, context);
      const tags = JSON.stringify(args.tags ?? []);
      const metadata = JSON.stringify(
        buildInitialTraceMetadata(
          {},
          {
            contentHash: await sha256Hex(args.content),
            ...(scopeId ? { scopeId } : {}),
          }
        )
      );

      await this.brain.transaction(async (trx) => {
        await trx.run(
          `INSERT INTO memory_traces
             (brain_id, id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
           VALUES (?, ?, ?, ?, ?, NULL, 1.0, ?, NULL, 0, ?, '{}', ?, 0, ?)`,
          [this.brain.brainId, traceId, type, scope, args.content, now, tags, metadata, scopeId ?? ''],
        );

        await trx.run(
          this.brain.features.fts.syncInsert('memory_traces_fts', '(SELECT rowid FROM memory_traces WHERE id = ?)', ['content', 'tags']),
          [traceId, args.content, tags],
        );
      });

      return { success: true, output: { traceId } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
