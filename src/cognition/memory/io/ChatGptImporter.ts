/**
 * @fileoverview ChatGPT export importer for AgentOS memory brain.
 *
 * Parses the `conversations.json` file produced by ChatGPT's "Export data"
 * feature and imports each conversation into the target `Brain`.
 *
 * ## Import strategy
 *
 * For each conversation object in `conversations.json`:
 * 1. A row is inserted into the `conversations` table (deduped by title + created_at).
 * 2. Every user/assistant message pair is encoded as an **episodic memory trace**
 *    whose content is `"[user]: {user_text}\n[assistant]: {assistant_text}"`.
 *    This preserves conversational context in a single retrievable unit.
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
   * Creates a `conversations` row and then iterates through the message
   * mapping in tree order (BFS), pairing adjacent user/assistant messages
   * into episodic memory traces.
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

    // Insert the conversation row (ignore duplicates by title + created_at).
    const conversationId = `cv_${uuidv4()}`;

    try {
      const { dialect } = this.brain.features;
      await this.brain.run(
        dialect.insertOrIgnore(
          'conversations',
          ['brain_id', 'id', 'title', 'created_at', 'updated_at', 'metadata'],
          ['?', '?', '?', '?', '?', '?'],
        ),
        [
          this.brain.brainId,
          conversationId,
          title,
          createdAt,
          updatedAt,
          JSON.stringify({ source: 'chatgpt_export' }),
        ],
      );
    } catch (err) {
      result.errors.push(`Conversation insert error for "${title}": ${String(err)}`);
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
   * Insert a single episodic memory trace derived from a message pair.
   *
   * Deduplication is based on SHA-256 of the combined `content` string, inside
   * the `user` scope and the scope id `''` these traces file under.
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

    // Dedup check.
    if (options?.dedup ?? true) {
      const { dialect } = this.brain.features;
      const existing = await this.brain.get<{ id: string }>(
        `SELECT id FROM memory_traces
          WHERE brain_id = ? AND scope = 'user' AND scope_id = ''
            AND ${dialect.jsonExtract('metadata', '$.import_hash')} = ?
          LIMIT 1`,
        [this.brain.brainId, hash],
      );

      if (existing) {
        result.skipped++;
        return;
      }
    }

    try {
      await this.brain.run(
        `INSERT INTO memory_traces
             (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
              retrieval_count, tags, emotions, metadata, deleted, scope_id)
           VALUES (?, ?, 'episodic', 'user', ?, NULL, 1.0, ?, NULL, 0, '[]', '{}', ?, 0, '')`,
        [
          this.brain.brainId,
          `mt_${uuidv4()}`,
          content,
          createdAt,
          JSON.stringify({
            import_hash: hash,
            source: 'chatgpt_export',
            conversation_id: conversationId,
          }),
        ],
      );

      result.imported++;
    } catch (err) {
      result.errors.push(`Trace insert error: ${String(err)}`);
    }
  }
}
