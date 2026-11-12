/**
 * @file memorySubject.ts
 * Who a session's turns serve, as the memory hooks and the tools are told: the user the session named, or, when it
 * named none or an anonymous id, the session itself.
 *
 * @module api/runtime/memorySubject
 */
import type { MemoryHookContext } from '../agent.js';
import { DEFAULT_ANONYMOUS_USER_IDS } from '../../cognition/learning/types.js';
import { memoryLog } from '../../cognition/memory/log.js';

/**
 * The user a session's options name. Undefined when they name none, and for an anonymous id (`system`, `anonymous`,
 * `guest` and the like, and any id the agent's `learning.anonymousUserIds` adds), which is never a user: one
 * `memory.anonymous_user` line is then written.
 *
 * @param userId - The `userId` the session was opened with.
 * @param path - The runtime the session runs on, for the log line.
 * @param anonymousUserIds - The agent's own anonymous ids (`learning.anonymousUserIds`), beside the built-in ones.
 */
export function namedSessionUser(
  userId: string | undefined,
  path: 'plain' | 'gmi',
  anonymousUserIds?: readonly string[] | null,
): string | undefined {
  if (userId === undefined) return undefined;
  if (typeof userId === 'string' && !isAnonymousUserId(userId, anonymousUserIds)) return userId;
  memoryLog.warn('memory.anonymous_user', { path });
  return undefined;
}

/** True for a built-in anonymous id and for one of the agent's own, compared after trimming. */
export function isAnonymousUserId(userId: string, anonymousUserIds: readonly string[] | null | undefined): boolean {
  const id = userId.trim();
  if (DEFAULT_ANONYMOUS_USER_IDS.includes(id)) return true;
  return Array.isArray(anonymousUserIds) && anonymousUserIds.some((other) => typeof other === 'string' && other.trim() === id);
}

/** The context of one session turn, or of one one-shot call, whose own id is its session and its subject. */
export function memoryHookContextOf(input: {
  sessionId: string;
  namedUser?: string;
  agentId?: string;
  call: 'session' | 'one-shot';
}): MemoryHookContext {
  const { sessionId, namedUser, agentId, call } = input;
  return {
    sessionId,
    userId: namedUser ?? sessionId,
    subject: namedUser !== undefined ? { kind: 'user', id: namedUser } : { kind: 'session', id: sessionId },
    ...(namedUser !== undefined ? { providerUserId: namedUser } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    call,
  };
}
