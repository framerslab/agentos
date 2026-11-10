/**
 * @fileoverview The scope id of one subject's conversation memory with one agent.
 * @module memory/retrieval/store/conversationScopeKey
 */

/** The scope that holds conversation traces and the chunks of wiki pages. */
export const CONVERSATION_SCOPE = 'conversation';

/** Who a conversation-memory scope belongs to: a named user, an anonymous session, or the operator's own pages. */
export type ConversationSubject =
  | { kind: 'user'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'operator' };

const LETTER = { user: 'u', session: 's', operator: 'o' } as const;

/**
 * The scope id of one subject's conversation memory with one agent, version `c1`:
 * `c1:<k>:<n>:<agentId>:<m>:<subjectId>;` where `<k>` is `u`, `s` or `o`, `<n>` and `<m>` are the lengths of the two
 * ids in UTF-16 code units, written in decimal, and `;` closes the key. The operator form has `<m>` = 0 and an empty
 * subject id. The ids are kept as given: no encoding, no case folding, no Unicode normalisation.
 *
 * @throws TypeError on an empty agent id, an empty user or session id, or a kind that is none of the three.
 */
export function conversationScopeKey(agentId: string, subject: ConversationSubject): string {
  if (typeof agentId !== 'string' || agentId === '') {
    throw new TypeError('conversationScopeKey: agentId must be a non-empty string');
  }
  if (subject?.kind === 'operator') return `c1:o:${agentId.length}:${agentId}:0:;`;
  if (subject?.kind !== 'user' && subject?.kind !== 'session') {
    throw new TypeError('conversationScopeKey: subject.kind must be user, session or operator');
  }
  if (typeof subject.id !== 'string' || subject.id === '') {
    throw new TypeError('conversationScopeKey: a user or session subject needs a non-empty id');
  }
  return `c1:${LETTER[subject.kind]}:${agentId.length}:${agentId}:${subject.id.length}:${subject.id};`;
}

/** The parts of a key `conversationScopeKey` wrote; undefined for any other string. */
export function parseConversationScopeKey(
  scopeId: string,
): { agentId: string; subject: ConversationSubject } | undefined {
  if (typeof scopeId !== 'string' || !scopeId.startsWith('c1:')) return undefined;
  const letter = scopeId.charAt(3);
  if ((letter !== 'u' && letter !== 's' && letter !== 'o') || scopeId.charAt(4) !== ':') return undefined;
  let at = 5;
  // A length is "0" or digits with no leading zero, so one key has one spelling.
  const readLength = (): number | undefined => {
    const colon = scopeId.indexOf(':', at);
    if (colon < 0) return undefined;
    const digits = scopeId.slice(at, colon);
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) return undefined;
    const length = Number(digits);
    if (!Number.isSafeInteger(length)) return undefined;
    at = colon + 1;
    return length;
  };
  const agentLength = readLength();
  if (agentLength === undefined || agentLength === 0 || at + agentLength > scopeId.length) return undefined;
  const agentId = scopeId.slice(at, at + agentLength);
  at += agentLength;
  if (scopeId.charAt(at) !== ':') return undefined;
  at += 1;
  const subjectLength = readLength();
  if (subjectLength === undefined || at + subjectLength > scopeId.length) return undefined;
  const subjectId = scopeId.slice(at, at + subjectLength);
  at += subjectLength;
  if (scopeId.charAt(at) !== ';' || at + 1 !== scopeId.length) return undefined;
  if (letter === 'o') return subjectLength === 0 ? { agentId, subject: { kind: 'operator' } } : undefined;
  if (subjectLength === 0) return undefined;
  return { agentId, subject: { kind: letter === 'u' ? 'user' : 'session', id: subjectId } };
}
