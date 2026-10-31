/**
 * @fileoverview Bridges the GMI with the Cognitive Memory subsystem.
 *
 * Provides a clean interface for PAD-state derivation, memory tag construction,
 * prompt-context assembly, encoding new memories, and syncing a full turn's
 * input/output into the cognitive memory store.
 *
 * Extracted from GMI.ts to isolate cognitive memory concerns from the core
 * cognitive engine while preserving full feature parity.
 *
 * @module cognitive_substrate/CognitiveMemoryBridge
 */

import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import type { PADState } from '../memory/core/config.js';
import type {
  AssembledMemoryContext,
  MemoryScope,
  MemorySourceType,
  MemoryTrace,
  MemoryType,
} from '../memory/core/types.js';
import { couldBeSessionForm, scopeIdOf, taggedScopeId } from '../learning/scopes.js';
import type { GuardedMemoryWrite, TurnScopes } from '../learning/types.js';
import { GMIMood, GMIInteractionType } from './IGMI';
import type { UserContext, GMITurnInput } from './IGMI';
import { turnContentText } from './turnContent';

/**
 * Identity of the turn a memory retrieval runs for. The bridge combines it
 * with the GMI's user and persona to decide which memory scopes a turn may
 * read.
 */
export interface CognitiveMemoryTurnScope {
  /** Session the turn belongs to. */
  sessionId?: string;
  /** Conversation thread of the turn (defaults to the session upstream). */
  conversationId?: string;
  /** Organization the turn runs under, when known. */
  organizationId?: string;
  /** Where a learning layer exists: the turn's scope ids, which take the place of the lists below. */
  learning?: CognitiveMemoryTurnLearning;
}

/**
 * A turn's memory where a learning layer exists: the scope ids the turn files and reads under, the second user
 * it names, and the guard every filing of the user's words runs through.
 */
export interface CognitiveMemoryTurnLearning {
  /** The turn's scope ids: the learner's two, or, on a turn with no learner, the session's, in a form no user id takes. */
  scopes: TurnScopes;
  /** On a turn with no learner: the explicit id of a user other than the session's learner, written on each trace. */
  turnUserId?: string;
  /**
   * Runs one filing inside the user's write chain, with the user's tombstone read before it and once it has
   * committed (`ILearnerSession.guardMemoryWrite`, bound to the turn). Without it the filing runs unguarded.
   */
  guard?: <T>(
    write: GuardedMemoryWrite<T>,
  ) => Promise<{ status: 'written'; result: T } | { status: 'rejected'; reason: 'forgotten' | 'store_unavailable' }>;
}

/**
 * Returns the value when it is a string with visible characters. The value is
 * not trimmed, so ids match the way the bridge wrote them.
 */
function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Options for encoding a piece of content into cognitive memory.
 */
export interface CognitiveMemoryEncodeOptions {
  /** The semantic type of the memory trace (e.g., 'episodic', 'semantic'). */
  type: MemoryType;
  /** What produced the content (e.g., 'user_statement', 'agent_inference'). */
  sourceType: MemorySourceType;
  /** Scope identifier — typically a userId or sessionId. */
  scopeId?: string;
  /** The conversational role that produced this content. */
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Optional additional tags to attach to the memory trace. */
  tags?: string[];
  /**
   * Where a learning layer exists: the trace is filed under the turn's own user scope id (`scopeId` is not read),
   * names the turn's second user, and is written only while that user's tombstone is clear.
   */
  learning?: CognitiveMemoryTurnLearning;
}

/**
 * Bridges a GMI instance with the Cognitive Memory subsystem.
 *
 * All methods are safe to call even when `cognitiveMemory` was not provided
 * (they degrade to no-ops). This allows the GMI to unconditionally delegate
 * without null-checking at every call site.
 *
 * State that belongs to the GMI (mood, user context, persona ID) is accessed
 * via getter callbacks so the bridge always sees the latest values without
 * needing direct mutation access.
 */
export class CognitiveMemoryBridge {
  /**
   * Creates a new CognitiveMemoryBridge.
   *
   * @param cognitiveMemory - The cognitive memory manager instance.
   * @param getMood - Callback returning the GMI's current mood.
   * @param getUserContext - Callback returning the GMI's current user context.
   * @param getPersonaId - Callback returning the active persona's ID.
   * @param getGmiId - Callback returning the GMI instance ID (used as fallback scope).
   * @param addTraceEntry - Callback to add entries to the GMI's reasoning trace.
   */
  constructor(
    private readonly cognitiveMemory: ICognitiveMemoryManager,
    private readonly getMood: () => GMIMood,
    private readonly getUserContext: () => UserContext,
    private readonly getPersonaId: () => string,
    private readonly getGmiId: () => string,
    private readonly addTraceEntry: (type: string, message: string, details?: Record<string, any>) => void,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Derives the PAD (Pleasure-Arousal-Dominance) state from the current GMI mood.
   *
   * Each mood maps to a fixed PAD vector used by the cognitive memory system
   * for encoding strength calculations and emotional context tagging.
   *
   * @returns The PAD state vector corresponding to the current mood.
   */
  public getPadState(): PADState {
    const mood = this.getMood();
    switch (mood) {
      case GMIMood.EMPATHETIC:
        return { valence: 0.55, arousal: 0.15, dominance: 0.25 };
      case GMIMood.CURIOUS:
        return { valence: 0.35, arousal: 0.45, dominance: 0.15 };
      case GMIMood.ASSERTIVE:
        return { valence: 0.15, arousal: 0.35, dominance: 0.7 };
      case GMIMood.ANALYTICAL:
        return { valence: 0.1, arousal: -0.1, dominance: 0.45 };
      case GMIMood.FOCUSED:
        return { valence: 0.2, arousal: 0.1, dominance: 0.55 };
      case GMIMood.FRUSTRATED:
        return { valence: -0.65, arousal: 0.6, dominance: 0.2 };
      case GMIMood.CREATIVE:
        return { valence: 0.45, arousal: 0.35, dominance: 0.35 };
      case GMIMood.NEUTRAL:
      default:
        return { valence: 0, arousal: 0, dominance: 0 };
    }
  }

  /**
   * Builds a de-duplicated set of tags for a memory trace.
   *
   * Tags include the message role, active persona ID, current user ID, and
   * the task domain. Falsy or whitespace-only values are filtered out.
   *
   * @param role - The conversational role producing the content.
   * @returns A unique array of non-empty tag strings.
   */
  public buildTags(role: 'user' | 'assistant' | 'tool' | 'system'): string[] {
    const userCtx = this.getUserContext();
    const tags = [
      role,
      this.getPersonaId(),
      userCtx?.userId,
      (userCtx as any)?.domain,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return Array.from(new Set(tags));
  }

  /**
   * Lists the memory scopes a turn may read, in the shape
   * `CognitiveRetrievalOptions.scopes` expects:
   *
   * - `user` scope for the user id, and for the session id and GMI id, where
   *   {@link CognitiveMemoryBridge.syncForTurn} and
   *   {@link CognitiveMemoryBridge.encode} place user input, assistant replies
   *   and traces written without a user;
   * - `thread` scope for the conversation id and the session id;
   * - `persona` scope for the persona id and for the per-user persona id
   *   (`<userId>::<personaId>`) that the memory tools write;
   * - `organization` scope for the turn's organization id and the user
   *   context's, which the memory tools write under, when known;
   * - every scope for the memory manager's owner id, under which the manager
   *   files a trace written without a scope id.
   *
   * Scopes owned by other users or other sessions are never listed.
   *
   * Where a learning layer exists (`turn.learning`) the lists are the turn's own: see
   * {@link CognitiveMemoryBridge.learnerRetrievalScopes}.
   *
   * @param turn - Session, conversation and organization of the current turn.
   * @returns A de-duplicated scope list.
   */
  public buildRetrievalScopes(
    turn?: CognitiveMemoryTurnScope,
  ): Array<{ scope: MemoryScope; scopeId: string }> {
    if (turn?.learning) return this.learnerRetrievalScopes(turn, turn.learning.scopes);
    const userId = nonBlank(this.getUserContext()?.userId);
    const personaId = nonBlank(this.getPersonaId());
    const sessionId = nonBlank(turn?.sessionId);

    const scopes: Array<{ scope: MemoryScope; scopeId: string }> = [];
    const seen = new Set<string>();
    const add = (scope: MemoryScope, scopeId: string | undefined): void => {
      if (!scopeId || seen.has(`${scope}:${scopeId}`)) return;
      seen.add(`${scope}:${scopeId}`);
      scopes.push({ scope, scopeId });
    };

    add('user', userId);
    add('user', sessionId);
    add('user', nonBlank(this.getGmiId()));
    add('thread', nonBlank(turn?.conversationId));
    add('thread', sessionId);
    add('persona', personaId);
    if (userId && personaId) {
      add('persona', `${userId}::${personaId}`);
    }
    add('organization', nonBlank(turn?.organizationId));
    add('organization', nonBlank(this.getUserContext()?.organizationId));
    // The manager files a trace written without a scope id under its own
    // owner id, whatever the scope (AgentMemory.remember writes `thread`).
    const owner = this.memoryOwnerId();
    for (const scope of ['user', 'thread', 'persona', 'organization'] as const) {
      add(scope, owner);
    }
    return scopes;
  }

  /**
   * The scopes a turn reads where a learning layer exists. `user` holds the turn's own scope id alone, the
   * learner's or the session's form, never the GMI id or the memory owner id, either of which a user id can equal.
   * `thread` holds the turn's conversation and session ids in the session's form, and the owner id in its plain form
   * unless it could equal a session's form. `persona` holds the turn's persona scope, the persona id and the owner id.
   * `organization` holds the turn's own organization id, never the owner id, and the user context's organization only
   * when it is the turn's: a user-context override of an earlier turn leaves its organization on the GMI for every
   * later turn, and a turn of another organization must not read it. A turn that names no organization takes the user
   * context's when it is the namespace of the turn's scope ids.
   */
  private learnerRetrievalScopes(
    turn: CognitiveMemoryTurnScope,
    scopes: TurnScopes,
  ): Array<{ scope: MemoryScope; scopeId: string }> {
    const list: Array<{ scope: MemoryScope; scopeId: string }> = [];
    const seen = new Set<string>();
    const add = (scope: MemoryScope, scopeId: string | undefined): void => {
      if (!scopeId || seen.has(`${scope}:${scopeId}`)) return;
      seen.add(`${scope}:${scopeId}`);
      list.push({ scope, scopeId });
    };
    const personaId = nonBlank(this.getPersonaId());
    const owner = this.memoryOwnerId();
    add('user', scopes.userScopeId);
    for (const id of [nonBlank(turn.conversationId), nonBlank(turn.sessionId)]) {
      if (id) add('thread', taggedScopeId(id, scopes.namespace));
    }
    if (owner && !couldBeSessionForm(owner)) add('thread', owner);
    add('persona', scopes.personaScopeId);
    if (personaId) add('persona', scopeIdOf(personaId));
    if (owner) add('persona', scopeIdOf(owner));
    const turnOrganization = nonBlank(turn.organizationId);
    add('organization', turnOrganization);
    const contextOrganization = nonBlank(this.getUserContext()?.organizationId);
    if (contextOrganization && contextOrganization === (turnOrganization ?? nonBlank(scopes.namespace))) {
      add('organization', contextOrganization);
    }
    return list;
  }

  /**
   * The memory manager's owner id (`CognitiveMemoryConfig.agentId`), the scope
   * id the manager gives a trace written without one (consolidated schemas,
   * `AgentMemory.remember` with default options).
   */
  private memoryOwnerId(): string | undefined {
    try {
      return nonBlank(this.cognitiveMemory.getConfig?.()?.agentId);
    } catch {
      return undefined;
    }
  }

  /**
   * Assembles a cognitive memory context suitable for injection into the LLM prompt.
   *
   * Queries the memory store for relevant traces, assembles them into a text
   * block with token budget constraints, and returns the assembled context.
   * Retrieval is limited to the scopes returned by
   * {@link CognitiveMemoryBridge.buildRetrievalScopes}, so a memory backend
   * shared by several sessions never surfaces another user's or another
   * session's traces in this turn's prompt.
   *
   * @param query - The user's current input text to use as a retrieval query.
   * @param turn - Session, conversation and organization of the current turn.
   * @returns The assembled memory context, or null if cognitive memory is unavailable
   *   or the query is empty.
   */
  public async assembleContext(
    query: string,
    turn?: CognitiveMemoryTurnScope,
  ): Promise<AssembledMemoryContext | null> {
    if (!query.trim()) {
      return null;
    }

    try {
      const scopes = this.buildRetrievalScopes(turn);
      // An empty list would make the store search every scope it knows of.
      if (scopes.length === 0) {
        return null;
      }
      const context = await this.cognitiveMemory.assembleForPrompt(
        query,
        1600,
        this.getPadState(),
        { scopes },
      );
      if (context.contextText.trim()) {
        this.addTraceEntry('DEBUG', 'Cognitive memory context assembled.', {
          tokensUsed: context.tokensUsed,
          includedMemoryIds: context.includedMemoryIds,
        });
      }
      return context;
    } catch (error: any) {
      this.addTraceEntry('WARNING', 'Cognitive memory assembly failed.', {
        error: error?.message ?? String(error),
      });
      return null;
    }
  }

  /**
   * Encodes a piece of content into the cognitive memory store.
   *
   * First fires the observer hook (if available), then encodes the content
   * with the current PAD state, mood, and derived tags.
   *
   * With `options.learning`, the trace goes under the turn's user scope id through the turn's guard; a refused filing
   * is traced with its reason, never its words, and feeds no observer either.
   *
   * @param content - The text content to encode.
   * @param options - Encoding options (type, sourceType, scopeId, role, and the turn's learning).
   */
  public async encode(content: string, options: CognitiveMemoryEncodeOptions): Promise<void> {
    if (!content.trim()) {
      return;
    }

    const learning = options.learning;
    const userCtx = this.getUserContext();
    const scopeId = learning ? learning.scopes.userScopeId : options.scopeId ?? userCtx.userId ?? this.getGmiId();
    const file = async (): Promise<MemoryTrace> => {
      await this.cognitiveMemory.observe?.(options.role, content, this.getPadState());
      return this.cognitiveMemory.encode(content, this.getPadState(), this.getMood(), {
        type: options.type,
        scope: 'user',
        scopeId,
        sourceType: options.sourceType,
        tags: options.tags ?? this.buildTags(options.role),
        ...(learning?.turnUserId ? { turnUserId: learning.turnUserId } : {}),
      });
    };
    try {
      if (!learning?.guard) {
        await file();
        return;
      }
      const outcome = await learning.guard({
        apply: file,
        undo: async (trace) => {
          if (typeof this.cognitiveMemory.deleteTraces !== 'function') {
            throw new Error('the memory manager has no deleteTraces');
          }
          await this.cognitiveMemory.deleteTraces([trace.id]);
        },
      });
      if (outcome.status === 'rejected') {
        this.addTraceEntry(
          outcome.reason === 'forgotten' ? 'DEBUG' : 'WARNING',
          `Cognitive memory did not file the ${options.role} message (${outcome.reason}).`,
          { role: options.role, reason: outcome.reason },
        );
      }
    } catch (error: any) {
      this.addTraceEntry('WARNING', 'Cognitive memory encoding failed.', {
        role: options.role,
        error: error?.message ?? String(error),
      });
    }
  }

  /**
   * Syncs a full turn's input and output into cognitive memory.
   *
   * - User input (TEXT or MULTIMODAL_CONTENT) is encoded as an episodic
   *   memory with sourceType 'user_statement'.
   * - The assistant's response text is encoded as a semantic memory with
   *   sourceType 'agent_inference'.
   *
   * @param turnInput - The turn's input payload.
   * @param responseText - The assistant's generated response text.
   * @param learning - Where a learning layer exists: both are filed under the turn's own user scope id, each through
   *   the turn's guard.
   */
  public async syncForTurn(
    turnInput: GMITurnInput,
    responseText: string,
    learning?: CognitiveMemoryTurnLearning,
  ): Promise<void> {
    const inputText = this.stringifyTurnContent(turnInput.content);
    const userCtx = this.getUserContext();
    const filing = learning ? { learning } : {};

    if (inputText && (
      turnInput.type === GMIInteractionType.TEXT ||
      turnInput.type === GMIInteractionType.MULTIMODAL_CONTENT
    )) {
      await this.encode(inputText, {
        type: 'episodic',
        sourceType: 'user_statement',
        scopeId: userCtx.userId,
        role: 'user',
        ...filing,
      });
    }

    if (responseText.trim()) {
      await this.encode(responseText, {
        type: 'semantic',
        sourceType: 'agent_inference',
        scopeId: turnInput.sessionId ?? userCtx.userId ?? this.getGmiId(),
        role: 'assistant',
        ...filing,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts turn content to a non-empty string or null.
   *
   * @param content - The raw turn content (string or structured object).
   * @returns The stringified content, or null if empty/invalid.
   */
  private stringifyTurnContent(content: GMITurnInput['content']): string | null {
    // As text, with no image data: memory keeps what was said, not base64.
    const text = turnContentText(content).trim();
    return text && text !== 'null' ? text : null;
  }
}
