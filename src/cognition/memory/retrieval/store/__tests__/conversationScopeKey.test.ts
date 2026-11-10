/**
 * @file conversationScopeKey.test.ts
 * The scope id of one subject's conversation memory with one agent: the three forms the encoder writes (a named user,
 * a session with no user, the operator's own pages), that two subjects never share a key and never hold one another's
 * key as a prefix whatever their ids contain, that the parser reads back every key the encoder writes and reads no
 * other string as one, and that an empty id is refused.
 */
import { beforeAll, describe, expect, it } from 'vitest';

type Subject = { kind: 'user'; id: string } | { kind: 'session'; id: string } | { kind: 'operator' };

interface KeyModule {
  CONVERSATION_SCOPE: string;
  conversationScopeKey(agentId: string, subject: Subject): string;
  parseConversationScopeKey(scopeId: string): { agentId: string; subject: Subject } | undefined;
}

let mod: KeyModule;

beforeAll(async () => {
  mod = (await import('../conversationScopeKey.js' as string)) as KeyModule;
});

describe('conversationScopeKey', () => {
  it('writes the three forms', () => {
    expect(mod.CONVERSATION_SCOPE).toBe('conversation');
    expect(mod.conversationScopeKey('aria', { kind: 'user', id: 'bob' })).toBe('c1:u:4:aria:3:bob;');
    expect(mod.conversationScopeKey('aria', { kind: 'session', id: 'bob' })).toBe('c1:s:4:aria:3:bob;');
    expect(mod.conversationScopeKey('aria', { kind: 'operator' })).toBe('c1:o:4:aria:0:;');
  });

  it('gives two keys for two subjects whatever their ids hold', () => {
    const pairs: Array<[[string, Subject], [string, Subject]]> = [
      [
        ['aria', { kind: 'user', id: 'alice' }],
        ['aria', { kind: 'user', id: 'alice-corp' }],
      ],
      [
        [':b', { kind: 'user', id: 'a::b' }],
        ['b::b', { kind: 'user', id: 'a' }],
      ],
      [
        ['aria', { kind: 'user', id: 'bob' }],
        ['aria', { kind: 'session', id: 'bob' }],
      ],
      [
        ['aria', { kind: 'user', id: 'Alice' }],
        ['aria', { kind: 'user', id: 'alice' }],
      ],
      [
        // The same letter in its composed and its decomposed Unicode form.
        ['aria', { kind: 'user', id: 'é' }],
        ['aria', { kind: 'user', id: 'é' }],
      ],
      [
        ['aria-1', { kind: 'user', id: 'u' }],
        ['aria-10', { kind: 'user', id: 'u' }],
      ],
    ];
    for (const [[agentA, subjectA], [agentB, subjectB]] of pairs) {
      const a = mod.conversationScopeKey(agentA, subjectA);
      const b = mod.conversationScopeKey(agentB, subjectB);
      expect(a).not.toBe(b);
      expect(a.startsWith(b)).toBe(false);
      expect(b.startsWith(a)).toBe(false);
    }
  });

  it('reads back every key it writes', () => {
    const agentIds = ['aria', 'a:b;c', ':', '0'];
    const subjectIds = ['bob', 'a::b', '..', '%2F', ';', 'x'.repeat(300), '\u{1F600}'];
    for (const agentId of agentIds) {
      const operator: Subject = { kind: 'operator' };
      expect(mod.parseConversationScopeKey(mod.conversationScopeKey(agentId, operator))).toEqual({
        agentId,
        subject: operator,
      });
      for (const id of subjectIds) {
        for (const kind of ['user', 'session'] as const) {
          const subject: Subject = { kind, id };
          expect(mod.parseConversationScopeKey(mod.conversationScopeKey(agentId, subject))).toEqual({
            agentId,
            subject,
          });
        }
      }
    }
  });

  it('reads no other string as a key', () => {
    const notKeys = [
      '',
      'aria-1',
      'c1:u:4:aria:3:bob',
      'c1:u:4:aria:3:bob;x',
      'c1:u:04:aria:3:bob;',
      'c1:u:4:aria:03:bob;',
      'c1:x:4:aria:3:bob;',
      'c1:o:4:aria:3:bob;',
      'c1:u:4:aria:0:;',
      'c2:u:4:aria:3:bob;',
      'c1:u:9:aria:3:bob;',
      'c1:u:0::3:bob;',
    ];
    for (const text of notKeys) {
      expect(mod.parseConversationScopeKey(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it('refuses an empty id', () => {
    expect(() => mod.conversationScopeKey('', { kind: 'user', id: 'bob' })).toThrow(TypeError);
    expect(() => mod.conversationScopeKey('aria', { kind: 'user', id: '' })).toThrow(TypeError);
    expect(() => mod.conversationScopeKey('aria', { kind: 'session', id: '' })).toThrow(TypeError);
  });
});
