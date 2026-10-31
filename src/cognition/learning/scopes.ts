/**
 * @module learning/scopes
 *
 * The written form of every scope id a learning layer files and reads. A learner's own scopes are `user:<u>`
 * and `persona:<u>::<personaId>`: `<u>` is `<namespace>/<userId>` with both parts percent-encoded when the learner's
 * namespace is set, and the user id in its plain form when it is `''`. A turn with no learner files under its
 * session's scopes, whose `<s>` takes a form no user id takes: `/` and the session id with no namespace, and
 * `<namespace>//<session>`, both parts encoded, with one. A turn's own conversation and session ids are written in
 * `thread` in that same form. Every other plain id (a persona id, a memory owner id, a GMI id) keeps its form unless it
 * holds a `/`, a `%` or a `:`, which is percent-encoded (`scopeIdForm.ts`). No plain form holds a `/`, every namespaced
 * form holds exactly one between two non-empty parts, and every session form starts with `/` or holds `//`, so the
 * forms never collide. The bridge, the memory tools, the standalone retriever and sink, `hydrateScope`,
 * `deleteScope` and `forgetUser` take every scope id from here.
 */
import { encodePlainId, encodeScopeIdPart } from '../memory/retrieval/store/scopeIdForm.js';

/** A user and persona scope id pair. */
export interface ScopeIdPair {
  userScopeId: string;
  personaScopeId: string;
}

/** Any plain id in its written form: unchanged unless it holds a `/`, a `%` or a `:`. */
export function scopeIdOf(id: string): string {
  return encodePlainId(id);
}

/** A learner's `<u>`. */
export function learnerUserScopeId(key: { namespace: string; userId: string }): string {
  return key.namespace ? `${encodeScopeIdPart(key.namespace)}/${encodeScopeIdPart(key.userId)}` : scopeIdOf(key.userId);
}

/** A learner's two scope ids. */
export function learnerScopeIds(key: { namespace: string; userId: string }, personaId: string): ScopeIdPair {
  const userScopeId = learnerUserScopeId(key);
  return { userScopeId, personaScopeId: `${userScopeId}::${scopeIdOf(personaId)}` };
}

/** A turn's own `thread` id (its conversation or session id) in the session form. */
export function taggedScopeId(id: string, namespace: string): string {
  return namespace ? `${encodeScopeIdPart(namespace)}//${encodeScopeIdPart(id)}` : `/${scopeIdOf(id)}`;
}

/** The two scope ids of a turn with no learner: its session's, in the session form, under the turn's namespace. */
export function sessionScopeIds(sessionId: string, namespace: string, personaId: string): ScopeIdPair {
  const userScopeId = taggedScopeId(sessionId, namespace);
  return { userScopeId, personaScopeId: `${userScopeId}::${scopeIdOf(personaId)}` };
}

/** Whether an owner id could equal a session form (it begins with `/` or holds `//`): the bridge leaves it out of `thread`. */
export function couldBeSessionForm(id: string): boolean {
  return id.startsWith('/') || id.includes('//');
}
