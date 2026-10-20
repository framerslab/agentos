/**
 * @fileoverview `ConversationManager` persistence on the storage library's real
 * adapters: sql.js, better-sqlite3 (sql.js where the native module does not
 * load) and, when `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint
 * job sets it), PostgreSQL, where each test gets a schema of its own (the
 * library's `segment`), dropped when the suite ends. A second manager on the
 * same database stands for a restarted process.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { ConversationContext } from '../ConversationContext.js';
import { ConversationManager, type ConversationManagerConfig } from '../ConversationManager.js';
import { MessageRole, createConversationMessage, type ConversationMessage } from '../ConversationMessage.js';
import { ensureConversationTables } from '../conversationTables.js';
import { GMIErrorCode } from '../../utils/errors.js';

/** A millisecond time past PostgreSQL's INTEGER limit of 2147483647. */
const T = 1_760_000_000_000;

/** The tables as the first version made them: INTEGER timestamps, none of the later columns. */
const FIRST_VERSION_TABLES = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmi_instance_id TEXT,
  title TEXT,
  language TEXT,
  session_details TEXT DEFAULT '{}',
  is_archived INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  multimodal_data TEXT,
  audio_url TEXT,
  audio_transcript TEXT,
  voice_settings TEXT,
  metadata TEXT DEFAULT '{}',
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
`;

/** One message of every kind a conversation holds, with every field the table keeps. */
function everyKindOfMessage(): ConversationMessage[] {
  const voice = {
    ...createConversationMessage(MessageRole.USER, 'Is it a cat?', { id: 'm-voice', timestamp: T + 5 }),
    audioUrl: 'https://example.com/clip.ogg',
    audioTranscript: 'is it a cat',
    voiceSettings: { voice: 'alloy', speed: 1.1 },
    multimodalData: { images: [{ url: 'https://example.com/cat.png' }] },
  } as ConversationMessage;
  return [
    createConversationMessage(MessageRole.SYSTEM, 'You answer briefly.', { id: 'm-system', timestamp: T }),
    createConversationMessage(
      MessageRole.USER,
      [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
      { id: 'm-parts', timestamp: T + 1, metadata: { source: 'direct_text_input', customTags: ['photo'] } },
    ),
    // The assistant's call and the tool's answer share a millisecond; ids sort the other way round.
    createConversationMessage(MessageRole.ASSISTANT, null, {
      id: 'm-z-call',
      timestamp: T + 2,
      tool_calls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'cats' } }],
      thinkingBlocks: [
        { type: 'thinking', thinking: 'Look it up.', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque' },
      ],
    }),
    createConversationMessage(MessageRole.TOOL, '{"breed":"tabby"}', {
      id: 'm-a-result',
      timestamp: T + 2,
      name: 'lookup',
      tool_call_id: 'call_1',
    }),
    createConversationMessage(MessageRole.USER, '[1, 2]', { id: 'm-brackets', timestamp: T + 3 }),
    createConversationMessage(MessageRole.USER, 'null', { id: 'm-null-text', timestamp: T + 3 }),
    createConversationMessage(MessageRole.SUMMARY, 'Earlier: the user asked about a cat.', {
      id: 'm-summary',
      timestamp: T + 4,
      originalMessagesSummarizedCount: 4,
    }),
    voice,
    createConversationMessage(MessageRole.ASSISTANT, 'A tabby.', { id: 'm-reply', timestamp: T + 6, metadata: { tokenCount: 3 } }),
  ];
}

async function managerOn(db: StorageAdapter, config: ConversationManagerConfig = {}): Promise<ConversationManager> {
  const manager = new ConversationManager();
  await manager.initialize({ persistenceEnabled: true, ...config }, undefined, db);
  return manager;
}

async function countMessages(db: StorageAdapter, conversationId: string): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?',
    [conversationId],
  );
  return Number(row?.n ?? 0);
}

/** Opens an empty database: a fresh one, or a schema of its own on PostgreSQL. */
type OpenDatabase = () => Promise<{ db: StorageAdapter; postgres: boolean }>;

function runPersistenceSuite(label: string, openDatabase: OpenDatabase): void {
  describe(`ConversationManager persistence on ${label}`, () => {
    const opened: StorageAdapter[] = [];
    const open: OpenDatabase = async () => {
      const database = await openDatabase();
      opened.push(database.db);
      return database;
    };
    afterEach(async () => {
      for (const db of opened.splice(0)) await db.close();
    });

    it('loads every message field back in a restarted process, in the order the conversation had', async () => {
      const { db } = await open();
      const messages = everyKindOfMessage();
      const writer = await managerOn(db);
      const context = new ConversationContext('conv-fields', { userId: 'u-1', gmiInstanceId: 'gmi-1' }, messages, { title: 'Cats' });
      await writer.saveConversation(context);
      // A second save rewrites every row: the order and the fields hold.
      await writer.saveConversation(context);

      const loaded = await (await managerOn(db)).getConversation('conv-fields');
      expect(loaded).not.toBeNull();
      expect(loaded!.getAllMessages()).toEqual(messages);
      expect(loaded!.getAllMessages().map((message) => message.id)).toEqual(messages.map((message) => message.id));
      expect(loaded!.getMessageById('m-z-call')!.content).toBeNull();
      expect(loaded!.getMessageById('m-a-result')!.content).toBe('{"breed":"tabby"}');
      expect(loaded!.getMessageById('m-brackets')!.content).toBe('[1, 2]');
      expect(loaded!.getMessageById('m-null-text')!.content).toBe('null');
      expect(loaded!.createdAt).toBe(context.createdAt);
      expect(loaded!.userId).toBe('u-1');
      expect(loaded!.gmiInstanceId).toBe('gmi-1');
      expect(loaded!.getMetadata('title')).toBe('Cats');
    });

    it('reads the stored times back as numbers', async () => {
      const { db } = await open();
      const writer = await managerOn(db);
      const context = await writer.getOrCreateConversationContext('conv-times', 'u-1');
      context.addMessage({ role: MessageRole.USER, content: 'hello' });
      const before = Date.now();
      await writer.saveConversation(context);

      const reader = await managerOn(db);
      expect(await reader.getConversationInfo('conv-times')).toEqual([{ sessionId: 'conv-times', createdAt: context.createdAt }]);
      expect(await reader.listContextsForSession('conv-times')).toEqual([{ sessionId: 'conv-times', createdAt: context.createdAt }]);
      const lastActive = await reader.getLastActiveTimeForConversation('conv-times');
      expect(typeof lastActive).toBe('number');
      expect(lastActive).toBeGreaterThanOrEqual(before);

      expect(await reader.getConversationInfo('conv-missing')).toEqual([]);
      expect(await reader.getLastActiveTimeForConversation('conv-missing')).toBeUndefined();
      expect(await reader.getConversation('conv-missing')).toBeNull();
    });

    it('saves a conversation that has no user, and reads it back without one', async () => {
      const { db } = await open();
      const writer = await managerOn(db);
      const context = await writer.getOrCreateConversationContext('conv-anonymous');
      context.addMessage({ role: MessageRole.USER, content: 'no account' });
      await writer.saveConversation(context);

      const loaded = await (await managerOn(db)).getConversation('conv-anonymous');
      expect(loaded!.userId).toBeUndefined();
      expect(loaded!.getAllMessages().map((message) => message.content)).toEqual(['no account']);
    });

    it('rewrites a saved message that changed in memory', async () => {
      const { db } = await open();
      const writer = await managerOn(db);
      const context = await writer.getOrCreateConversationContext('conv-rewrite', 'u-1');
      const reply = context.addMessage({ role: MessageRole.ASSISTANT, content: 'draft' });
      await writer.saveConversation(context);
      context.replaceMessageContent(reply.id, 'final', { rewritten: true });
      await writer.saveConversation(context);

      const loaded = await (await managerOn(db)).getConversation('conv-rewrite');
      expect(loaded!.getMessageById(reply.id)).toMatchObject({ content: 'final', metadata: { rewritten: true } });
      expect(await countMessages(db, 'conv-rewrite')).toBe(1);
    });

    it('in append-only mode keeps the first text of a message, adds new ones and refuses deletion', async () => {
      const { db } = await open();
      const writer = await managerOn(db, { appendOnlyPersistence: true });
      expect(writer.appendOnlyPersistence).toBe(true);
      const context = await writer.getOrCreateConversationContext('conv-sealed', 'u-1');
      const first = context.addMessage({ role: MessageRole.USER, content: 'first words' });
      await writer.saveConversation(context);
      context.replaceMessageContent(first.id, 'changed later');
      const reply = context.addMessage({ role: MessageRole.ASSISTANT, content: 'reply' });
      await writer.saveConversation(context);

      const reader = await managerOn(db, { appendOnlyPersistence: true });
      const loaded = await reader.getConversation('conv-sealed');
      expect(loaded!.getAllMessages().map((message) => message.content)).toEqual(['first words', 'reply']);
      expect(await reader.getLastActiveTimeForConversation('conv-sealed')).toBe(reply.timestamp);
      await expect(writer.deleteConversation('conv-sealed')).rejects.toMatchObject({ code: GMIErrorCode.METHOD_NOT_SUPPORTED });
      expect(await countMessages(db, 'conv-sealed')).toBe(2);
    });

    it('deletes a conversation with its messages', async () => {
      const { db } = await open();
      const writer = await managerOn(db);
      const context = await writer.getOrCreateConversationContext('conv-gone', 'u-1');
      context.addMessage({ role: MessageRole.USER, content: 'one' });
      context.addMessage({ role: MessageRole.ASSISTANT, content: 'two' });
      await writer.saveConversation(context);
      expect(await countMessages(db, 'conv-gone')).toBe(2);

      await writer.deleteConversation('conv-gone');
      expect(await countMessages(db, 'conv-gone')).toBe(0);
      expect(await (await managerOn(db)).getConversation('conv-gone')).toBeNull();
    });

    it('saves a conversation it evicts from memory, and every conversation at shutdown', async () => {
      const { db } = await open();
      const writer = await managerOn(db, { maxActiveConversationsInMemory: 1 });
      const evicted = await writer.getOrCreateConversationContext('conv-evicted', 'u-1');
      evicted.addMessage({ role: MessageRole.USER, content: 'said before eviction' });
      const kept = await writer.getOrCreateConversationContext('conv-at-shutdown', 'u-1');
      kept.addMessage({ role: MessageRole.USER, content: 'said before shutdown' });
      await writer.shutdown();

      const reader = await managerOn(db);
      expect((await reader.getConversation('conv-evicted'))!.getAllMessages().map((m) => m.content)).toEqual(['said before eviction']);
      expect((await reader.getConversation('conv-at-shutdown'))!.getAllMessages().map((m) => m.content)).toEqual(['said before shutdown']);
      // A conversation found on disk is cached: the second call is answered from memory.
      const cached = await reader.getOrCreateConversationContext('conv-evicted', 'u-1');
      expect(await reader.getOrCreateConversationContext('conv-evicted')).toBe(cached);
    });

    it('brings tables the first version made up to date and reads their rows as that version did', async () => {
      const { db, postgres } = await open();
      await db.exec(FIRST_VERSION_TABLES);
      await db.run(
        `INSERT INTO conversations (id, user_id, session_details, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ['conv-old', 'u-old', '{"userId":"u-old"}', 1_000_000, 1_000_003],
      );
      const oldRows: Array<[string, string, number]> = [
        ['old-json', '{"a":1}', 1_000_001],
        ['old-null', 'null', 1_000_002],
        ['old-braces', '{not json}', 1_000_003],
      ];
      for (const [id, content, timestamp] of oldRows) {
        await db.run(
          'INSERT INTO conversation_messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          [id, 'conv-old', 'user', content, timestamp],
        );
      }

      expect(await ensureConversationTables(db)).toEqual({
        addedColumns: ['content_type', 'name', 'thinking_blocks', 'summarized_count', 'seq'],
        widenedColumns: postgres ? 3 : 0,
      });
      expect(await ensureConversationTables(db)).toEqual({ addedColumns: [], widenedColumns: 0 });

      const manager = await managerOn(db);
      const loaded = await manager.getConversation('conv-old');
      expect(loaded!.getAllMessages().map((message) => message.content)).toEqual([{ a: 1 }, 'null', '{not json}']);
      expect(loaded!.createdAt).toBe(1_000_000);

      loaded!.addMessage({ role: MessageRole.ASSISTANT, content: 'a millisecond time fits now' });
      await manager.saveConversation(loaded!);
      const reloaded = await (await managerOn(db)).getConversation('conv-old');
      const contents = reloaded!.getAllMessages().map((message) => message.content);
      expect(contents).toEqual([{ a: 1 }, 'null', '{not json}', 'a millisecond time fits now']);
      expect(reloaded!.getAllMessages()[3].timestamp).toBeGreaterThan(2_147_483_647);
    });
  });
}

runPersistenceSuite('sql.js', async () => ({
  db: await resolveStorageAdapter({ filePath: ':memory:', priority: ['sqljs'], quiet: true }),
  postgres: false,
}));

runPersistenceSuite('better-sqlite3', async () => ({
  db: await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true }),
  postgres: false,
}));

const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const segments: string[] = [];

describe.skipIf(!postgresUrl)('on PostgreSQL', () => {
  runPersistenceSuite('PostgreSQL', async () => {
    const segment = `agentos_cm_${run}_${segments.length + 1}`;
    segments.push(segment);
    const db = createPostgresAdapter({ connectionString: postgresUrl!, segment });
    await db.open();
    return { db, postgres: true };
  });

  afterAll(async () => {
    const db = createPostgresAdapter({ connectionString: postgresUrl! });
    await db.open();
    try {
      for (const segment of segments) await db.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await db.close();
    }
  });
});
