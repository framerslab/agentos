/**
 * @fileoverview ChatGPT export importer for AgentOS memory brain.
 *
 * Parses the `conversations.json` file produced by ChatGPT's "Export data"
 * feature and imports each conversation into the target `Brain`.
 *
 * ## Import strategy
 *
 * For each conversation object in `conversations.json`:
 * 1. The conversation has one row in the `conversations` table, named after
 *    it: `cv_chatgpt_` and the SHA-256 of the export's id for it
 *    (`conversation_id`, else `id`), else of its title and creation time. A
 *    later import of the conversation finds the row by that name, through a
 *    rename and without a `create_time` when the export names it by an id; a
 *    conversation the export names by neither gets a row of its own at each
 *    import. When the export's update time is later than the row's, the row
 *    takes it and the conversation's title.
 * 2. Every user/assistant message pair is encoded as an **episodic memory trace**
 *    whose content is `"[user]: {user_text}\n[assistant]: {assistant_text}"`.
 *    This preserves conversational context in a single retrievable unit.
 *    With deduplication on (the default), the trace is named after the brain
 *    and its text, `mt_chatgpt_` and their SHA-256.
 * 3. System messages and tool messages are skipped (they are not episodic memories).
 *
 * ## ChatGPT export format
 * ```json
 * [
 *   {
 *     "title": "Conversation title",
 *     "create_time": 1711234567.89,
 *     "mapping": {
 *       "node-id": {
 *         "message": {
 *           "author": { "role": "user" },
 *           "content": { "parts": ["Hello!"] }
 *         },
 *         "children": ["next-node-id"]
 *       }
 *     }
 *   }
 * ]
 * ```
 *
 * @module memory/io/ChatGptImporter
 */

import { sha256 } from '../core/util/crossPlatformCrypto.js';
import { v4 as uuidv4 } from 'uuid';
import type { ImportOptions, ImportResult } from './facade/types.js';
import type { Brain } from '../retrieval/store/Brain.js';
import { fillScopeIds } from '../retrieval/store/migrations/v2-to-v3.js';
import { duplicateTraceCondition, duplicateTraceParams } from './importScope.js';

// ---------------------------------------------------------------------------
// ChatGPT export format types
// ---------------------------------------------------------------------------

/** Author of a ChatGPT message. */
interface ChatGptAuthor {
  role: 'user' | 'assistant' | 'system' | 'tool';
}

/** Content block of a ChatGPT message. */
interface ChatGptContent {
  /** Array of text parts (always strings for text messages). */
  parts?: unknown[];
}

/** A single message node in the conversation mapping. */
interface ChatGptMessage {
  author?: ChatGptAuthor;
  content?: ChatGptContent;
  create_time?: number | null;
}

/** A node in the conversation tree (may or may not have a message). */
interface ChatGptNode {
  id?: string;
  message?: ChatGptMessage | null;
  parent?: string | null;
  children?: string[];
}

/** A single conversation entry in `conversations.json`. */
interface ChatGptConversation {
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  mapping?: Record<string, ChatGptNode>;
  /** The export's id for the conversation. */
  conversation_id?: string | null;
  /** The same id, under the name some exports give it. */
  id?: string | null;
}

/** The export's id for a conversation: its `conversation_id`, else its `id`, when either is a non-empty string. */
function exportedConversationId(convo: ChatGptConversation): string | undefined {
  for (const value of [convo.conversation_id, convo.id]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * The name of a conversation's `conversations` row: `cv_chatgpt_` and the SHA-256 of what names the
 * conversation, the export's id for it, else its title and creation time. Undefined for a conversation the
 * export names by neither, an id or a creation time.
 */
async function conversationRowName(
  exportId: string | undefined,
  title: string,
  exportedCreatedAt: number | undefined,
): Promise<string | undefined> {
  if (exportId !== undefined) return `cv_chatgpt_${await sha256(JSON.stringify(['id', exportId]))}`;
  if (exportedCreatedAt === undefined) return undefined;
  return `cv_chatgpt_${await sha256(JSON.stringify(['title', title, exportedCreatedAt]))}`;
}

/**
 * An insert of one row into `table` that does nothing when the brain holds a row of its primary key
 * `(brain_id, id)`, on SQLite and PostgreSQL; any other failure, such as a missing value, still fails it.
 */
function insertUnlessHeld(table: string, columns: string[], values: string[]): string {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT (brain_id, id) DO NOTHING`;
}

// ---------------------------------------------------------------------------
// ChatGptImporter
// ---------------------------------------------------------------------------

/**
 * Imports a ChatGPT `conversations.json` export into a `Brain`.
 *
 * **Usage:**
 * ```ts
 * const importer = new ChatGptImporter(brain);
 * const result = await importer.import('/path/to/conversations.json');
 * ```
 */
export class ChatGptImporter {
  /**
   * @param brain - The target `Brain` to import into.
   */
  constructor(private readonly brain: Brain) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse `conversations.json` and import all conversations and message pairs.
   *
   * @param sourcePath - Absolute path to the ChatGPT `conversations.json` file.
   * @returns `ImportResult` with counts of imported traces, skipped duplicates,
   *   and any per-item error messages.
   */
  async import(sourcePath: string, options?: Pick<ImportOptions, 'dedup'>): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

    // ---- Load + parse ----
    let raw: string;
    try {
      const fs = await import('node:fs/promises');
      raw = await fs.readFile(sourcePath, 'utf8');
    } catch (err) {
      result.errors.push(`Failed to read file: ${String(err)}`);
      return result;
    }

    let conversations: ChatGptConversation[];
    try {
      conversations = JSON.parse(raw) as ChatGptConversation[];
    } catch (err) {
      result.errors.push(`Invalid JSON: ${String(err)}`);
      return result;
    }

    if (!Array.isArray(conversations)) {
      result.errors.push('Expected a JSON array at the top level of conversations.json');
      return result;
    }

    // A trace an older release wrote holds scope_id '': filed under its scope id first, it is not read as ''.
    if (options?.dedup ?? true) await fillScopeIds(this.brain.adapter, this.brain.brainId);

    // ---- Process each conversation ----
    for (const convo of conversations) {
      try {
        await this._importConversation(convo, result, options);
      } catch (err) {
        result.errors.push(`Conversation import error: ${String(err)}`);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Import a single ChatGPT conversation object.
   *
   * Writes the conversation's `conversations` row, or finds the one it has
   * (see `_conversationRow`), and then iterates through the message mapping in
   * tree order (BFS), pairing adjacent user/assistant messages into episodic
   * memory traces whose metadata names that row.
   *
   * @param convo  - Raw ChatGPT conversation object.
   * @param result - Mutable result accumulator.
   */
  private async _importConversation(
    convo: ChatGptConversation,
    result: ImportResult,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<void> {
    const title = convo.title ?? 'Untitled';
    const createdAt = convo.create_time ? Math.round(convo.create_time * 1000) : Date.now();
    const updatedAt = convo.update_time ? Math.round(convo.update_time * 1000) : createdAt;

    let conversationId: string;
    try {
      conversationId = await this._conversationRow(
        exportedConversationId(convo),
        title,
        convo.create_time ? createdAt : undefined,
        createdAt,
        updatedAt,
      );
    } catch (err) {
      result.errors.push(`Conversation row error for "${title}": ${String(err)}`);
      return;
    }

    if (!convo.mapping) return;

    // ---- Extract messages in tree order ----
    // The mapping is a flat record of nodes keyed by ID.  We use BFS starting
    // from the root (node with no parent) to traverse in conversation order.
    const nodes = convo.mapping;

    // Find root node(s) — nodes with no parent or null parent.
    const rootIds = Object.keys(nodes).filter(
      (id) => !nodes[id]?.parent,
    );

    // Collect messages in BFS order.
    const orderedMessages: Array<{ role: string; text: string; time: number }> = [];

    const queue = [...rootIds];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodes[nodeId];
      if (!node) continue;

      const msg = node.message;
      if (msg?.author?.role && msg.content?.parts) {
        const textParts = (msg.content.parts as unknown[])
          .filter((p): p is string => typeof p === 'string')
          .join('');

        if (textParts.trim()) {
          orderedMessages.push({
            role: msg.author.role,
            text: textParts,
            time: msg.create_time ? Math.round(msg.create_time * 1000) : createdAt,
          });
        }
      }

      // Enqueue children in order.
      for (const childId of node.children ?? []) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    // ---- Pair user + assistant messages into episodic traces ----
    // We slide through the ordered messages and pair each user message with
    // the immediately following assistant message.
    for (let i = 0; i < orderedMessages.length; i++) {
      const msg = orderedMessages[i]!;

      // Skip system / tool messages.
      if (msg.role === 'system' || msg.role === 'tool') continue;

      if (msg.role === 'user') {
        // Look ahead for an assistant response.
        const next = orderedMessages[i + 1];
        const assistantText =
          next?.role === 'assistant' ? next.text : '';

        const content =
          assistantText
            ? `[user]: ${msg.text}\n[assistant]: ${assistantText}`
            : `[user]: ${msg.text}`;

        await this._insertEpisodicTrace(content, msg.time, conversationId, result, options);

        // Skip the assistant message on the next iteration if we consumed it.
        if (assistantText) i++;
      }
    }
  }

  /**
   * The id of a conversation's `conversations` row. A conversation the export
   * names by an id, or by no id but with a `create_time`, has a row named after
   * it (`conversationRowName`), which a later import of it finds by that name:
   * through a rename and without a `create_time` when the export names it by
   * an id. The row is written with an insert that does nothing when the brain
   * holds a row of that name, so two imports that write one conversation's row
   * at the same time, in one process or in two, write one row and both file
   * under it. A row of any other name is never taken. A conversation the export
   * names by neither has nothing to find it by: each import writes it a row of
   * its own. The row then takes the conversation's title and the export's
   * update time when that update time is later than the row's. The row's
   * metadata records the export's id as `chatgpt_id`.
   *
   * @param exportId          - The export's id for the conversation, when it names one.
   * @param title             - The conversation's title.
   * @param exportedCreatedAt - Its creation time in ms, when the export gives one.
   * @param createdAt         - The creation time a new row takes, in ms.
   * @param updatedAt         - Its update time, in ms.
   * @returns The row's id.
   */
  private async _conversationRow(
    exportId: string | undefined,
    title: string,
    exportedCreatedAt: number | undefined,
    createdAt: number,
    updatedAt: number,
  ): Promise<string> {
    const brainId = this.brain.brainId;
    const named = await conversationRowName(exportId, title, exportedCreatedAt);
    const conversationId = named ?? `cv_${uuidv4()}`;
    await this.brain.run(
      insertUnlessHeld(
        'conversations',
        ['brain_id', 'id', 'title', 'created_at', 'updated_at', 'metadata'],
        ['?', '?', '?', '?', '?', '?'],
      ),
      [
        brainId,
        conversationId,
        title,
        createdAt,
        updatedAt,
        JSON.stringify(exportId === undefined ? { source: 'chatgpt_export' } : { source: 'chatgpt_export', chatgpt_id: exportId }),
      ],
    );
    if (named !== undefined) {
      await this.brain.run(
        'UPDATE conversations SET updated_at = ?, title = ? WHERE brain_id = ? AND id = ? AND updated_at < ?',
        [updatedAt, title, brainId, conversationId, updatedAt],
      );
    }
    return conversationId;
  }

  /**
   * Insert a single episodic memory trace derived from a message pair.
   *
   * Deduplication works inside the `user` scope and the scope id `''` these
   * traces file under: a trace there that holds the combined `content` string,
   * or names its SHA-256 as `import_hash` or `content_hash`, makes the pair a
   * duplicate, whichever writer stored it. `import` first files the traces an
   * older release wrote with `scope_id` `''` under the scope id their metadata
   * names (`fillScopeIds`), so another scope id's trace is not taken for a
   * duplicate. With deduplication on, the trace is named after the brain and
   * the pair's text, and written with an insert that does nothing when the
   * brain holds a trace of that name, so two imports that store one pair at the
   * same time, each after finding no duplicate of it, store one trace: the
   * import whose insert wrote nothing counts the pair as a duplicate. With it
   * off, each import stores the pair again, under a random id.
   *
   * @param content        - The `[user]:...\n[assistant]:...` content string.
   * @param createdAt      - Unix timestamp (ms) of the user message.
   * @param conversationId - ID of the parent conversation row.
   * @param result         - Mutable result accumulator.
   */
  private async _insertEpisodicTrace(
    content: string,
    createdAt: number,
    conversationId: string,
    result: ImportResult,
    options?: Pick<ImportOptions, 'dedup'>,
  ): Promise<void> {
    const hash = await sha256(content);
    const dedup = options?.dedup ?? true;

    // Dedup check.
    if (dedup) {
      const existing = await this.brain.get<{ id: string }>(
        `SELECT id FROM memory_traces
          WHERE brain_id = ? AND scope = 'user' AND scope_id = ''
            AND ${duplicateTraceCondition(this.brain)}
          LIMIT 1`,
        [this.brain.brainId, ...duplicateTraceParams(hash, content)],
      );

      if (existing) {
        result.skipped++;
        return;
      }
    }

    try {
      const written = await this.brain.run(
        insertUnlessHeld(
          'memory_traces',
          [
            'brain_id', 'id', 'type', 'scope', 'content', 'embedding', 'strength', 'created_at', 'last_accessed',
            'retrieval_count', 'tags', 'emotions', 'metadata', 'deleted', 'scope_id',
          ],
          ['?', '?', "'episodic'", "'user'", '?', 'NULL', '1.0', '?', 'NULL', '0', "'[]'", "'{}'", '?', '0', "''"],
        ),
        [
          this.brain.brainId,
          dedup ? `mt_chatgpt_${await sha256(JSON.stringify([this.brain.brainId, content]))}` : `mt_${uuidv4()}`,
          content,
          createdAt,
          JSON.stringify({
            import_hash: hash,
            source: 'chatgpt_export',
            conversation_id: conversationId,
          }),
        ],
      );

      if (written.changes > 0) result.imported++;
      else result.skipped++;
    } catch (err) {
      result.errors.push(`Trace insert error: ${String(err)}`);
    }
  }
}
