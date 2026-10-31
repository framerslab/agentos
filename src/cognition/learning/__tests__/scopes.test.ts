/**
 * @file scopes.test.ts
 * The written form of every scope id a learning layer files and reads: a learner's (plain, and namespaced with both
 * parts encoded), a session's (a form no user id takes, per tenant), a turn's own thread ids, and any other plain id.
 * The forms never collide: no plain form holds a `/`, every namespaced form holds exactly one between two non-empty
 * parts, and every session form starts with `/` or holds `//`.
 */
import { describe, expect, it } from 'vitest';
import { couldBeSessionForm, learnerScopeIds, learnerUserScopeId, scopeIdOf, sessionScopeIds, taggedScopeId } from '../scopes';

/** Ids that hold each reserved character, a `//`, a leading `/`, a space and a character outside ASCII. */
const IDS = ['42', 'A', 'team/ana', 'a%2Fb', '/x', 'x//y', 'a:b', ' ', 'ü'];
const NAMESPACES = ['', 'A', 'B/C'];

describe('a learner', () => {
  it("files under the plain form with no namespace, a reserved character's id encoded", () => {
    expect(learnerScopeIds({ namespace: '', userId: '42' }, 'tutor')).toEqual({ userScopeId: '42', personaScopeId: '42::tutor' });
    expect(learnerScopeIds({ namespace: '', userId: 'team/ana' }, 'tutor')).toEqual({
      userScopeId: 'team%2Fana',
      personaScopeId: 'team%2Fana::tutor',
    });
    expect(learnerScopeIds({ namespace: '', userId: 'A/42' }, 'tutor').userScopeId).toBe('A%2F42');
  });

  it('files under <namespace>/<userId> with both parts encoded when the namespace is set', () => {
    expect(learnerScopeIds({ namespace: 'A', userId: '42' }, 'tutor')).toEqual({ userScopeId: 'A/42', personaScopeId: 'A/42::tutor' });
    expect(learnerScopeIds({ namespace: 'org one', userId: 'ana maria' }, 't').userScopeId).toBe('org%20one/ana%20maria');
    expect(learnerScopeIds({ namespace: 'A', userId: 'b/c' }, 't').userScopeId).toBe('A/b%2Fc');
    expect(learnerUserScopeId({ namespace: 'A/B', userId: 'a\uD800' })).toBe('A%2FB/a%uD800');
  });

  it("keeps the composite's :: its separator: a user id or persona id with a colon is encoded", () => {
    expect(learnerScopeIds({ namespace: '', userId: 'a:' }, 'x').personaScopeId).toBe('a%3A::x');
    expect(learnerScopeIds({ namespace: '', userId: 'a' }, ':x').personaScopeId).toBe('a::%3Ax');
  });
});

describe("a session and a turn's own thread", () => {
  it('takes a form no user id takes, apart per namespace', () => {
    expect(sessionScopeIds('s-1', '', 'tutor')).toEqual({ userScopeId: '/s-1', personaScopeId: '/s-1::tutor' });
    expect(sessionScopeIds('s-1', 'A', 'tutor')).toEqual({ userScopeId: 'A//s-1', personaScopeId: 'A//s-1::tutor' });
    expect(sessionScopeIds('s-1', 'B', 'tutor').userScopeId).not.toBe(sessionScopeIds('s-1', 'A', 'tutor').userScopeId);
  });

  it('files session ids a/b and a%2Fb into two scopes', () => {
    expect(sessionScopeIds('a/b', '', 'p').userScopeId).toBe('/a%2Fb');
    expect(sessionScopeIds('a%2Fb', '', 'p').userScopeId).toBe('/a%252Fb');
    expect(sessionScopeIds('a/b', 'A', 'p').userScopeId).toBe('A//a%2Fb');
  });

  it("writes a turn's conversation and session ids in the session form", () => {
    expect(taggedScopeId('conv-1', '')).toBe('/conv-1');
    expect(taggedScopeId('conv-1', 'A')).toBe('A//conv-1');
    expect(scopeIdOf('tutor')).toBe('tutor');
    expect(scopeIdOf('a:b')).toBe('a%3Ab');
    // A plain id with no reserved character keeps its form, a lone surrogate included; one with a reserved character
    // is encoded, its lone surrogate as %u and four hexadecimal digits.
    expect(scopeIdOf('a\uD800')).toBe('a\uD800');
    expect(scopeIdOf('a\uD800/')).toBe('a%uD800%2F');
  });

  it('never gives a session form that equals a learner form', () => {
    const learners = new Set<string>();
    for (const namespace of NAMESPACES) {
      for (const userId of IDS) learners.add(learnerScopeIds({ namespace, userId }, 'p').userScopeId);
    }
    for (const namespace of NAMESPACES) {
      for (const sessionId of IDS) expect(learners.has(sessionScopeIds(sessionId, namespace, 'p').userScopeId)).toBe(false);
    }
  });

  it('reads every session form as one an owner id could equal, and a plain id with neither a leading / nor a // as none', () => {
    for (const namespace of NAMESPACES) {
      for (const id of IDS) {
        expect(couldBeSessionForm(sessionScopeIds(id, namespace, 'p').userScopeId)).toBe(true);
        expect(couldBeSessionForm(taggedScopeId(id, namespace))).toBe(true);
      }
    }
    expect(couldBeSessionForm('tutor')).toBe(false);
    expect(couldBeSessionForm('a/b')).toBe(false);
    expect(couldBeSessionForm('/tutor')).toBe(true);
    expect(couldBeSessionForm('a//b')).toBe(true);
  });
});
