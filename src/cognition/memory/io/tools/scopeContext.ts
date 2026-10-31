/**
 * @module memory/tools/scopeContext
 *
 * The scope ids a memory tool call files and reads under. With no learning layer (no `sessionData.learning`), or a
 * learner session that gives no scope ids (a host's own, written against an earlier release), they come from the
 * call's context as they always have: the user id, `<userId>::<personaId>`, the conversation or session id and the
 * organization id. Where the GMI put the turn's scope ids on the call (`sessionData.learning.scopes`), `user` and
 * `persona` are the turn's own (the learner's, or its session's in a form no user id takes), `thread` is the call's
 * conversation, else its session, in the session's form, and `organization` is the turn's own organization; a call
 * reaches by id only the traces of those scopes that its own user filed.
 */
import type { ToolExecutionContext } from '../../../../core/tools/ITool.js';
import { taggedScopeId } from '../../../learning/scopes.js';
import { readToolLearningContext } from '../../../learning/toolContext.js';
import type { ProposalResult, SessionSelfChange, TurnScopes } from '../../../learning/types.js';
import type { MemoryScope } from '../../core/types.js';

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildPersonaScopeId(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

/** The call's conversation id, else its session id. */
function threadIdOf(context: ToolExecutionContext): string | undefined {
  return nonEmptyString(context.sessionData?.conversationId) ?? nonEmptyString(context.sessionData?.sessionId);
}

/** The call's organization id: the turn's (`sessionData.organizationId`), else the user context's. */
function organizationIdOf(context: ToolExecutionContext): string | undefined {
  return nonEmptyString(context.sessionData?.organizationId) ?? nonEmptyString(context.userContext?.organizationId);
}

/**
 * The organization of a call that carries the turn's scope ids: the turn's own (`sessionData.organizationId`). The
 * user context keeps an organization an earlier turn's override set, for every later turn, so its id counts only
 * when it is the namespace of the turn's scope ids.
 */
function turnOrganizationIdOf(context: ToolExecutionContext, scopes: TurnScopes): string | undefined {
  const own = nonEmptyString(context.sessionData?.organizationId);
  if (own) return own;
  const kept = nonEmptyString(context.userContext?.organizationId);
  return kept !== undefined && kept === scopes.namespace ? kept : undefined;
}

/** The turn's scope ids the GMI put on the call, or `undefined`: no learning layer, or a session that gives none. */
export function turnScopesOf(context: ToolExecutionContext): TurnScopes | undefined {
  return readToolLearningContext(context.sessionData)?.scopes;
}

/**
 * Resolve the effective scope identity for a memory tool call from the active
 * execution context.
 *
 * Without the turn's scope ids, `user` and `persona` are always resolvable in normal AgentOS tool execution because
 * `userContext.userId` and `personaId` are required; `thread` and `organization` additionally rely on optional
 * `sessionData`. With them, `user` and `persona` are the turn's own scope ids, `thread` is the call's conversation,
 * else its session, in the session's form (`taggedScopeId`), and `organization` is the turn's own organization id
 * (the user context's only when it is the namespace of the turn's scope ids).
 */
export function resolveMemoryToolScopeId(
  scope: string | undefined,
  context: ToolExecutionContext,
): string | undefined {
  const resolvedScope = nonEmptyString(scope);
  if (!resolvedScope) {
    return undefined;
  }

  const turn = turnScopesOf(context);
  if (turn) {
    switch (resolvedScope) {
      case 'user':
        return turn.userScopeId;
      case 'persona':
        return turn.personaScopeId;
      case 'thread': {
        const threadId = threadIdOf(context);
        return threadId ? taggedScopeId(threadId, turn.namespace) : undefined;
      }
      case 'organization':
        return turnOrganizationIdOf(context, turn);
      default:
        return undefined;
    }
  }

  const userId = nonEmptyString(context.userContext?.userId);
  const personaId = nonEmptyString(context.personaId);

  switch (resolvedScope) {
    case 'user':
      return userId;
    case 'persona':
      if (!userId || !personaId) {
        return undefined;
      }
      return buildPersonaScopeId(userId, personaId);
    case 'thread':
      return threadIdOf(context);
    case 'organization':
      return organizationIdOf(context);
    default:
      return undefined;
  }
}

/** A scope and one of its ids. */
export interface MemoryScopePair {
  scope: MemoryScope;
  scopeId: string;
}

/**
 * A memory tool call's turn, where the GMI put the turn's scope ids on the call: what a write files under and
 * reaches by id, what a search reads, the second user a write names, and the session's recorder.
 */
export interface MemoryToolTurn {
  scopes: TurnScopes;
  /**
   * The turn's own scopes: its `user` and `persona` scope ids, and its conversation's and its session's `thread` ids
   * in the session's form. A write files under one of them, and a call reaches by id only their traces of its own
   * user.
   */
  own: MemoryScopePair[];
  /** What `memory_search` reads besides the unscoped traces: the turn's own scopes and its organization's id. */
  readable: MemoryScopePair[];
  /** On a second user's turn with no learner: that user's explicit id, which each write files on its trace. */
  turnUserId?: string;
  /** The session's recorder, bound by the GMI to the call's own turn; absent on a session that records no writes. */
  record?: <T>(input: SessionSelfChange<T>) => Promise<ProposalResult<T>>;
}

/** The call's turn where it carries the turn's scope ids, or `undefined`: the tool acts as it does with no layer. */
export function memoryToolTurnOf(context: ToolExecutionContext): MemoryToolTurn | undefined {
  const learning = readToolLearningContext(context.sessionData);
  const scopes = learning?.scopes;
  if (!learning || !scopes) {
    return undefined;
  }
  const own: MemoryScopePair[] = [];
  const readable: MemoryScopePair[] = [];
  const add = (list: MemoryScopePair[], scope: MemoryScope, scopeId: string | undefined): void => {
    if (scopeId && !list.some((pair) => pair.scope === scope && pair.scopeId === scopeId)) {
      list.push({ scope, scopeId });
    }
  };
  add(own, 'user', scopes.userScopeId);
  add(own, 'persona', scopes.personaScopeId);
  for (const id of [nonEmptyString(context.sessionData?.conversationId), nonEmptyString(context.sessionData?.sessionId)]) {
    if (id) add(own, 'thread', taggedScopeId(id, scopes.namespace));
  }
  for (const pair of own) add(readable, pair.scope, pair.scopeId);
  add(readable, 'organization', turnOrganizationIdOf(context, scopes));
  return {
    scopes,
    own,
    readable,
    ...(learning.turnUserId ? { turnUserId: learning.turnUserId } : {}),
    ...(learning.recordSelfChange ? { record: learning.recordSelfChange } : {}),
  };
}
