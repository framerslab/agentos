/**
 * @file conversationRows.ts
 * @description How `ConversationManager` writes a message to a
 * `conversation_messages` row and reads it back, field for field and with each
 * field's type, on every backend the storage adapter opens.
 *
 * @license Apache-2.0
 */

import { createLogger, type ILogger } from '../logging/index.js';
import {
  createConversationMessage,
  type ConversationMessage,
  type MessageRole,
} from './ConversationMessage.js';

/**
 * The `conversation_messages` columns a message is written to, in the order
 * {@link messageRowValues} gives their values. `id` comes first.
 */
export const MESSAGE_ROW_COLUMNS = [
  'id',
  'conversation_id',
  'role',
  'content',
  'content_type',
  'timestamp',
  'seq',
  'tool_calls',
  'tool_call_id',
  'name',
  'thinking_blocks',
  'summarized_count',
  'multimodal_data',
  'audio_url',
  'audio_transcript',
  'voice_settings',
  'metadata',
] as const;

const PLACEHOLDERS = MESSAGE_ROW_COLUMNS.map(() => '?').join(', ');

/** Inserts a message row; the values are {@link messageRowValues}. */
export const INSERT_MESSAGE_SQL = `INSERT INTO conversation_messages (${MESSAGE_ROW_COLUMNS.join(', ')}) VALUES (${PLACEHOLDERS})`;

/** Inserts a message row or replaces the one with its id, on SQLite; the values are {@link messageRowValues}. */
export const REPLACE_MESSAGE_SQL = `INSERT OR REPLACE INTO conversation_messages (${MESSAGE_ROW_COLUMNS.join(', ')}) VALUES (${PLACEHOLDERS})`;

/** Rewrites a message row; the values are {@link updateMessageValues}. */
export const UPDATE_MESSAGE_SQL = `UPDATE conversation_messages SET ${MESSAGE_ROW_COLUMNS.slice(1)
  .map((column) => `${column} = ?`)
  .join(', ')} WHERE id = ?`;

/**
 * A conversation's messages, oldest first; messages that share a timestamp come
 * in the order they had when saved.
 */
export const SELECT_MESSAGES_SQL =
  'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp ASC, seq ASC';

/** How a row's `content` reads back: `text` as it is, `json` parsed. */
export type StoredContentType = 'text' | 'json';

/** A `conversation_messages` row as the driver returns it. */
export interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  /** Null on a row an earlier version wrote. */
  content_type?: string | null;
  /** A number, or a string where the driver reads BIGINT as one (PostgreSQL). */
  timestamp: number | string;
  /** The message's position in its conversation when it was saved; null on a row an earlier version wrote. */
  seq?: number | string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name?: string | null;
  thinking_blocks?: string | null;
  summarized_count?: number | string | null;
  multimodal_data: string | null;
  audio_url: string | null;
  audio_transcript: string | null;
  voice_settings: string | null;
  metadata: string | null;
}

/**
 * Fields a caller may set on a message beyond `ConversationMessage`, which the
 * table keeps in columns of their own.
 */
interface MessageMediaFields {
  multimodalData?: unknown;
  audioUrl?: string;
  audioTranscript?: string;
  voiceSettings?: unknown;
}

let logger: ILogger | undefined;

function log(): ILogger {
  return (logger ??= createLogger('ConversationManager'));
}

/**
 * A number read from a row: a millisecond time or a count. PostgreSQL's driver
 * reads a BIGINT as a string, so a string of digits counts.
 *
 * @param value - The column's value.
 * @returns The number, or undefined for null or a value that is not one.
 */
export function readNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The text a message's content is stored as, with the type it reads back as.
 * Text is stored as it is; null and an array of content parts are stored as
 * JSON.
 */
export function encodeContent(content: ConversationMessage['content'] | undefined): {
  content: string;
  contentType: StoredContentType;
} {
  if (typeof content === 'string') return { content, contentType: 'text' };
  return { content: JSON.stringify(content ?? null), contentType: 'json' };
}

/**
 * A row's content as the message had it. A row an earlier version wrote has no
 * `content_type`; its content is read as that version read it: text that starts
 * and ends with braces or brackets is parsed as JSON, and anything else, the
 * text `null` included, stays text.
 *
 * @param row - The row's id, content and content type.
 */
export function decodeContent(
  row: Pick<ConversationMessageRow, 'id' | 'content' | 'content_type'>,
): ConversationMessage['content'] {
  const stored = row.content;
  if (row.content_type === 'text') return stored;
  if (row.content_type === 'json') {
    try {
      return JSON.parse(stored) as ConversationMessage['content'];
    } catch {
      log().warn('Stored JSON content did not parse; reading it as text', { messageId: row.id });
      return stored;
    }
  }

  const looksLikeJson =
    typeof stored === 'string' &&
    ((stored.startsWith('{') && stored.endsWith('}')) || (stored.startsWith('[') && stored.endsWith(']')));
  if (!looksLikeJson) return stored;
  try {
    return JSON.parse(stored) as ConversationMessage['content'];
  } catch {
    log().debug?.('Content of a row without a content type kept as text', { messageId: row.id });
    return stored;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseOrUndefined<T>(text: string | null | undefined): T | undefined {
  return text ? (JSON.parse(text) as T) : undefined;
}

/**
 * The values of a message's row, in the order of {@link MESSAGE_ROW_COLUMNS}.
 *
 * @param messageId - The row's id.
 * @param conversationId - The conversation the message belongs to.
 * @param message - The message.
 * @param position - The message's index in its conversation.
 */
export function messageRowValues(
  messageId: string,
  conversationId: string,
  message: ConversationMessage,
  position: number,
): unknown[] {
  const media = message as ConversationMessage & MessageMediaFields;
  const { content, contentType } = encodeContent(message.content);
  return [
    messageId,
    conversationId,
    String(message.role),
    content,
    contentType,
    message.timestamp,
    position,
    message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    message.tool_call_id || null,
    message.name ?? null,
    jsonOrNull(message.thinkingBlocks),
    message.originalMessagesSummarizedCount ?? null,
    jsonOrNull(media.multimodalData),
    media.audioUrl || null,
    media.audioTranscript || null,
    jsonOrNull(media.voiceSettings),
    jsonOrNull(message.metadata),
  ];
}

/**
 * The values {@link UPDATE_MESSAGE_SQL} takes: every column but the id, then
 * the id.
 */
export function updateMessageValues(rowValues: unknown[]): unknown[] {
  return [...rowValues.slice(1), rowValues[0]];
}

/**
 * The message a row holds.
 *
 * @param row - A `conversation_messages` row.
 */
export function messageFromRow(row: ConversationMessageRow): ConversationMessage {
  const summarizedCount = readNumber(row.summarized_count);
  return createConversationMessage(row.role as MessageRole, decodeContent(row), {
    id: row.id,
    timestamp: readNumber(row.timestamp),
    tool_calls: parseOrUndefined(row.tool_calls),
    tool_call_id: row.tool_call_id || undefined,
    metadata: parseOrUndefined(row.metadata),
    ...(row.name != null && { name: row.name }),
    ...(row.thinking_blocks && { thinkingBlocks: JSON.parse(row.thinking_blocks) }),
    ...(summarizedCount !== undefined && { originalMessagesSummarizedCount: summarizedCount }),
    ...(row.multimodal_data && { multimodalData: JSON.parse(row.multimodal_data) }),
    ...(row.audio_url && { audioUrl: row.audio_url }),
    ...(row.audio_transcript && { audioTranscript: row.audio_transcript }),
    ...(row.voice_settings && { voiceSettings: JSON.parse(row.voice_settings) }),
  } as Parameters<typeof createConversationMessage>[2]);
}
