/**
 * @fileoverview The behaviour every `IStorageAdapter` shares, as one suite each
 * implementation runs: `InMemoryStorageAdapter`, and `SqlStorageAdapter` on
 * sql.js, better-sqlite3 and PostgreSQL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IConversation, IConversationMessage, IStorageAdapter } from '../IStorageAdapter.js';

/** How the suite gets an adapter for the backend under test. */
export interface StorageAdapterHarness {
  /** A new adapter, not yet initialized. The suite initializes and closes it. */
  create(): IStorageAdapter;
}

/**
 * A millisecond timestamp, as callers store them. It is past what a four-byte
 * integer holds, so a backend that stores timestamps in one fails here.
 */
const T0 = 1_760_000_000_000;

/**
 * Registers the contract's tests for one backend.
 *
 * @param name - The backend's name in the test titles.
 * @param harness - Makes the backend's adapters.
 */
export function runStorageAdapterContract(name: string, harness: StorageAdapterHarness): void {
  describe(`${name}: the IStorageAdapter contract`, () => {
    let storage: IStorageAdapter;
    let seq = 0;
    const id = (prefix: string): string => `${prefix}-${++seq}`;

    beforeAll(async () => {
      storage = harness.create();
      await storage.initialize();
    });

    afterAll(async () => {
      await storage?.close();
    });

    async function conversation(partial: Partial<IConversation> = {}): Promise<IConversation> {
      return storage.createConversation({
        id: id('conv'),
        userId: id('user'),
        createdAt: T0,
        lastActivity: T0,
        ...partial,
      });
    }

    function message(conversationId: string, partial: Partial<IConversationMessage> = {}): IConversationMessage {
      return { id: id('msg'), conversationId, role: 'user', content: 'hello', timestamp: T0, ...partial };
    }

    it('creates a conversation and reads it back', async () => {
      const created = await conversation({
        agentId: 'agent-a',
        title: 'Plans',
        metadata: { topic: 'trips', tags: ['a', 'b'] },
      });

      expect(await storage.getConversation(created.id)).toEqual({
        id: created.id,
        userId: created.userId,
        agentId: 'agent-a',
        createdAt: T0,
        lastActivity: T0,
        title: 'Plans',
        metadata: { topic: 'trips', tags: ['a', 'b'] },
      });
      expect(await storage.getConversation('missing')).toBeNull();
    });

    it('refuses a second conversation with the same id and keeps the first', async () => {
      const first = await conversation({ title: 'first' });

      await expect(storage.createConversation({ ...first, title: 'second' })).rejects.toThrow();
      expect((await storage.getConversation(first.id))?.title).toBe('first');
    });

    it('updates a conversation and refuses an update to one that does not exist', async () => {
      const created = await conversation({ title: 'before', metadata: { n: 1 } });

      const updated = await storage.updateConversation(created.id, {
        title: 'after',
        metadata: { n: 2 },
        lastActivity: T0 + 5,
      });

      expect(updated).toMatchObject({ id: created.id, title: 'after', metadata: { n: 2 }, lastActivity: T0 + 5 });
      expect(await storage.getConversation(created.id)).toMatchObject({
        title: 'after',
        metadata: { n: 2 },
        createdAt: T0,
        lastActivity: T0 + 5,
      });
      await expect(storage.updateConversation('missing', { title: 'x' })).rejects.toThrow(/not found/i);
    });

    it("lists a user's conversations newest first, by agent, and a page at a time by limit, offset or both", async () => {
      const user = id('user');
      for (let n = 1; n <= 5; n++) {
        await conversation({ id: `${user}-c${n}`, userId: user, agentId: n % 2 ? 'odd' : 'even', lastActivity: T0 + n });
      }
      await conversation(); // another user's
      const names = (list: IConversation[]): string[] => list.map((c) => c.id.slice(user.length + 1));

      expect(names(await storage.listConversations(user))).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);
      expect(names(await storage.listConversations(user, { agentId: 'odd' }))).toEqual(['c5', 'c3', 'c1']);
      expect(names(await storage.listConversations(user, { limit: 2 }))).toEqual(['c5', 'c4']);
      // An offset with no limit: SQLite reads OFFSET only after a LIMIT.
      expect(names(await storage.listConversations(user, { offset: 3 }))).toEqual(['c2', 'c1']);
      expect(names(await storage.listConversations(user, { limit: 2, offset: 1 }))).toEqual(['c4', 'c3']);
      expect(await storage.listConversations(id('user'))).toEqual([]);
    });

    it('stores messages and reads them by time, role and order, a page at a time', async () => {
      const conv = await conversation();
      const roles = ['system', 'user', 'assistant', 'tool'] as const;
      for (let n = 0; n < roles.length; n++) {
        await storage.storeMessage(
          message(conv.id, { id: `${conv.id}-m${n}`, role: roles[n], timestamp: T0 + 10 * (n + 1) })
        );
      }
      const names = (list: IConversationMessage[]): string[] => list.map((m) => m.id.slice(conv.id.length + 1));

      expect(names(await storage.getMessages(conv.id))).toEqual(['m0', 'm1', 'm2', 'm3']);
      expect(names(await storage.getMessages(conv.id, { order: 'desc' }))).toEqual(['m3', 'm2', 'm1', 'm0']);
      expect(names(await storage.getMessages(conv.id, { since: T0 + 20, until: T0 + 30 }))).toEqual(['m1', 'm2']);
      expect(names(await storage.getMessages(conv.id, { roles: ['user', 'tool'] }))).toEqual(['m1', 'm3']);
      expect(names(await storage.getMessages(conv.id, { limit: 2 }))).toEqual(['m0', 'm1']);
      expect(names(await storage.getMessages(conv.id, { offset: 2 }))).toEqual(['m2', 'm3']);
      expect(names(await storage.getMessages(conv.id, { limit: 1, offset: 1, order: 'desc' }))).toEqual(['m2']);
      expect(await storage.getMessageCount(conv.id)).toBe(4);
      expect(await storage.getMessages('missing')).toEqual([]);
      expect(await storage.getMessageCount('missing')).toBe(0);
    });

    it('reads back every field a message was stored with', async () => {
      const conv = await conversation();
      const stored = message(conv.id, {
        role: 'assistant',
        content: 'calling a tool',
        timestamp: T0 + 1,
        model: 'model-a',
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cacheReadTokens: 8, cacheCreationTokens: 2 },
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        toolCallId: 'call-0',
        name: 'helper',
        metadata: { trace: { step: 1 } },
      });

      await storage.storeMessage(stored);

      expect(await storage.getMessage(stored.id)).toEqual(stored);
      expect(await storage.getMessage('missing')).toBeNull();
    });

    it('keeps a usage of zero tokens', async () => {
      const conv = await conversation();
      const stored = message(conv.id, { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

      await storage.storeMessage(stored);

      expect((await storage.getMessage(stored.id))?.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });

    it('refuses a message for a conversation that does not exist', async () => {
      await expect(storage.storeMessage(message('missing'))).rejects.toThrow(/not found/i);
    });

    it('refuses a second message with the same id and keeps the first', async () => {
      const conv = await conversation();
      const first = message(conv.id, { content: 'first' });
      await storage.storeMessage(first);

      await expect(storage.storeMessage({ ...first, content: 'second' })).rejects.toThrow();

      expect((await storage.getMessage(first.id))?.content).toBe('first');
      expect(await storage.getMessageCount(conv.id)).toBe(1);
      expect((await storage.getMessages(conv.id)).map((m) => m.content)).toEqual(['first']);
    });

    it("moves the conversation's last activity to a newly stored message's time", async () => {
      const conv = await conversation();

      await storage.storeMessage(message(conv.id, { timestamp: T0 + 99 }));

      expect((await storage.getConversation(conv.id))?.lastActivity).toBe(T0 + 99);
    });

    it("deletes one message, then a conversation's messages, and says how many went", async () => {
      const conv = await conversation();
      const [a, b, c] = [1, 2, 3].map((n) => message(conv.id, { timestamp: T0 + n }));
      for (const m of [a, b, c]) await storage.storeMessage(m);

      expect(await storage.deleteMessage(a.id)).toBe(true);
      expect(await storage.deleteMessage(a.id)).toBe(false);
      expect(await storage.getMessage(a.id)).toBeNull();
      expect(await storage.getMessageCount(conv.id)).toBe(2);
      expect(await storage.deleteMessagesForConversation(conv.id)).toBe(2);
      expect(await storage.getMessages(conv.id)).toEqual([]);
      expect(await storage.getConversation(conv.id)).not.toBeNull();
    });

    it('deletes a conversation with its messages and leaves the others', async () => {
      const conv = await conversation();
      const kept = await conversation();
      const gone = message(conv.id, { timestamp: T0 + 1 });
      await storage.storeMessage(gone);
      await storage.storeMessage(message(kept.id, { timestamp: T0 + 2 }));

      expect(await storage.deleteConversation(conv.id)).toBe(true);

      expect(await storage.getConversation(conv.id)).toBeNull();
      expect(await storage.getMessage(gone.id)).toBeNull();
      expect(await storage.getMessageCount(conv.id)).toBe(0);
      expect(await storage.getMessageCount(kept.id)).toBe(1);
      expect(await storage.deleteConversation(conv.id)).toBe(false);
    });

    it('sums token usage, with cache counts only once a message reported them', async () => {
      const conv = await conversation();
      expect(await storage.getConversationTokenUsage(conv.id)).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });

      await storage.storeMessage(
        message(conv.id, { timestamp: T0 + 1, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
      );
      expect(await storage.getConversationTokenUsage(conv.id)).toEqual({
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      });

      await storage.storeMessage(
        message(conv.id, {
          timestamp: T0 + 2,
          usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24, cacheReadTokens: 16 },
        })
      );
      await storage.storeMessage(message(conv.id, { timestamp: T0 + 3 }));
      expect(await storage.getConversationTokenUsage(conv.id)).toEqual({
        promptTokens: 30,
        completionTokens: 6,
        totalTokens: 36,
        cacheReadTokens: 16,
      });
    });

    it('hands out copies: a change to an object passed in or handed back never reaches the store', async () => {
      const input: IConversation = {
        id: id('conv'),
        userId: id('user'),
        createdAt: T0,
        lastActivity: T0,
        metadata: { tags: ['a'] },
      };
      const returned = await storage.createConversation(input);
      input.metadata!.tags.push('from-input');
      returned.metadata!.tags.push('from-return');
      (await storage.getConversation(input.id))!.metadata!.tags.push('from-read');
      (await storage.listConversations(input.userId))[0].metadata!.tags.push('from-list');

      expect((await storage.getConversation(input.id))?.metadata).toEqual({ tags: ['a'] });

      const sent = message(input.id, {
        toolCalls: [{ id: 'call-1', args: { q: 'x' } }],
        metadata: { seen: false },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
      const handedBack = await storage.storeMessage(sent);
      sent.toolCalls![0].args.q = 'changed';
      sent.metadata!.seen = true;
      sent.usage!.totalTokens = 99;
      handedBack.metadata!.extra = 1;
      (await storage.getMessage(sent.id))!.toolCalls!.push({ id: 'call-2' });
      (await storage.getMessages(input.id))[0].metadata!.seen = 'listed';

      const after = await storage.getMessage(sent.id);
      expect(after?.toolCalls).toEqual([{ id: 'call-1', args: { q: 'x' } }]);
      expect(after?.metadata).toEqual({ seen: false });
      expect(after?.usage?.totalTokens).toBe(2);
    });

    it('refuses calls before initialize() and after close(), and takes a second initialize() or close()', async () => {
      const fresh = harness.create();
      await expect(fresh.getConversation('x')).rejects.toThrow(/initialize/);
      await fresh.close();

      await fresh.initialize();
      await fresh.initialize();
      expect(await fresh.getConversation('x')).toBeNull();

      await fresh.close();
      await fresh.close();
      await expect(fresh.getConversation('x')).rejects.toThrow(/initialize/);
    });
  });
}
