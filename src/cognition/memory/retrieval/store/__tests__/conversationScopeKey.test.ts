/**
 * @file conversationScopeKey.test.ts
 * The scope id of one subject's conversation memory with one agent: the three forms the encoder writes (a named user,
 * a session with no user, the operator's own pages), that two subjects never share a key and never hold one another's
 * key as a prefix whatever their ids contain, that the parser reads back every key the encoder writes and reads no
 * other string as one, and that an empty id is refused.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SCOPE,
  conversationScopeKey,
  parseConversationScopeKey,
  type ConversationSubject,
} from '../conversationScopeKey.js';

type Subject = ConversationSubject;

describe('conversationScopeKey', () => {
  it('writes the three forms', () => {
    expect(CONVERSATION_SCOPE).toBe('conversation');
    expect(conversationScopeKey('aria', { kind: 'user', id: 'bob' })).toBe('c1:u:4:aria:3:bob;');
    expect(conversationScopeKey('aria', { kind: 'session', id: 'bob' })).toBe('c1:s:4:aria:3:bob;');
    expect(conversationScopeKey('aria', { kind: 'operator' })).toBe('c1:o:4:aria:0:;');
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
      const a = conversationScopeKey(agentA, subjectA);
      const b = conversationScopeKey(agentB, subjectB);
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
      expect(parseConversationScopeKey(conversationScopeKey(agentId, operator))).toEqual({
        agentId,
        subject: operator,
      });
      for (const id of subjectIds) {
        for (const kind of ['user', 'session'] as const) {
          const subject: Subject = { kind, id };
          expect(parseConversationScopeKey(conversationScopeKey(agentId, subject))).toEqual({
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
      // A lone surrogate, which no key the encoder writes holds.
      'c1:u:4:aria:1:\uD800;',
      'c1:s:4:aria:2:b\uDC00;',
      'c1:o:5:ari\uD800a:0:;',
    ];
    for (const text of notKeys) {
      expect(parseConversationScopeKey(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it('refuses an empty id', () => {
    expect(() => conversationScopeKey('', { kind: 'user', id: 'bob' })).toThrow(TypeError);
    expect(() => conversationScopeKey('aria', { kind: 'user', id: '' })).toThrow(TypeError);
    expect(() => conversationScopeKey('aria', { kind: 'session', id: '' })).toThrow(TypeError);
  });

  it('refuses an id that holds a lone surrogate', () => {
    // A database writes text as UTF-8, where a lone surrogate becomes U+FFFD: 'a\uD800' would be stored as 'a�',
    // another subject's id, so such an id gets no key.
    expect(() => conversationScopeKey('aria', { kind: 'user', id: 'a\uD800' })).toThrow(TypeError);
    expect(() => conversationScopeKey('aria', { kind: 'session', id: '\uDC00b' })).toThrow(TypeError);
    expect(() => conversationScopeKey('aria', { kind: 'user', id: 'x\uDE00\uD83D' })).toThrow(TypeError);
    expect(() => conversationScopeKey('ari\uD800', { kind: 'operator' })).toThrow(TypeError);
    expect(() => conversationScopeKey('ari\uD800', { kind: 'user', id: 'bob' })).toThrow(TypeError);
    // A surrogate pair is one character, and U+FFFD itself is an id like any other.
    expect(conversationScopeKey('aria', { kind: 'user', id: 'a😀' })).toBe('c1:u:4:aria:3:a😀;');
    expect(conversationScopeKey('aria', { kind: 'user', id: 'a�' })).toBe('c1:u:4:aria:2:a�;');
  });

  it('refuses an id that holds a NUL, and reads no string that holds one as a key', () => {
    // Postgres stores no NUL in text: a key that held one could not be stored, so such an id gets no key.
    expect(() => conversationScopeKey('aria', { kind: 'user', id: 'a\u0000b' })).toThrow(TypeError);
    expect(() => conversationScopeKey('aria', { kind: 'session', id: '\u0000' })).toThrow(TypeError);
    expect(() => conversationScopeKey('ar\u0000ia', { kind: 'operator' })).toThrow(TypeError);
    expect(parseConversationScopeKey('c1:u:4:aria:3:a\u0000b;')).toBeUndefined();
    expect(parseConversationScopeKey('c1:o:5:ar\u0000ia:0:;')).toBeUndefined();
  });
});
