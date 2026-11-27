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
import type { ManagerRecallConfig, PADState } from '../memory/core/config.js';
import type { MemoryRecallCapture, RecallCaptureMode } from '../memory/retrieval/recall/capture.js';
import { recallBudgetTokens, type EffectiveRecallBudget } from '../memory/retrieval/recall/budget.js';
import { recallLog } from '../memory/retrieval/recall/log.js';
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
import type { SoulFiling, SoulTurnAnswer, SoulTurnMemory } from './soulTurnMemory';
import {
  errorNameOf,
  failedWriteEntry,
  memoryWriteRecordOf,
  writeEntryOf,
  type MemoryWriteEntry,
  type MemoryWriteRecord,
} from '../../api/runtime/memoryWriteRecord.js';

/** The emotional state a filing stamped `'neutral'` is stored with. */
const NEUTRAL_PAD: Readonly<PADState> = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });

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
  /** The high-level session's key within `user`, in a form distinct from any named user's key. @internal */
  sessionUserScopeId?: string;
  /** Where a learning layer exists: the turn's scope ids, which take the place of the lists below. */
  learning?: CognitiveMemoryTurnLearning;
  /**
   * A souled agent's view of the turn: on the manager of that agent's mind (`rows: 'mind'`) the turn reads the
   * person's key alone, in place of every list above, and nothing for a view with no key. On any other manager it is
   * not read.
   *
   * @internal
   */
  soul?: SoulTurnMemory;
  /**
   * The answer that view gave for the turn (`soul.begin()`). On the manager of a souled agent's mind, a turn's recall
   * drifts the emotional context of what it reads (reconsolidation) only when the answer allows it: an answer that
   * holds `reconsolidation: false`, the one a minor's turn and the turn of a person who objects to profiling get, and
   * a turn with no answer, read with `skipReconsolidation`. On any other manager it is not read.
   *
   * @internal
   */
  soulAnswer?: SoulTurnAnswer;
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

/** An integer for a log field: a count that is not finite is written as 0. */
function safeInt(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * The capture of the memory block one model hop is sent: `capture` with that hop's budget (the requested and
 * effective budget, the clamp's reason and inputs, the hop, and whether the block was rendered again for it).
 *
 * @param capture - The capture of the rendering the hop is sent.
 * @param budget - The hop's budget (`effectiveRecallBudget`).
 * @param hop - The hop's index on the turn's route; 0 for the primary.
 * @param reassembled - Whether the block was rendered again at `budget.effective` for this hop.
 * @returns A new capture; `capture` is not changed.
 */
export function captureForHop(capture: MemoryRecallCapture, budget: EffectiveRecallBudget, hop: number, reassembled: boolean): MemoryRecallCapture {
  return {
    ...capture,
    budget: {
      requested: budget.requested,
      effective: budget.effective,
      ...(budget.clampReason ? { clampReason: budget.clampReason } : {}),
      ...(budget.promptShareTokens !== undefined ? { promptShareTokens: budget.promptShareTokens, otherContextTokens: budget.otherContextTokens } : {}),
      ...(budget.fixedPromptTokens !== undefined ? { fixedPromptTokens: budget.fixedPromptTokens } : {}),
      hop,
      ...(reassembled ? { reassembled: true } : {}),
    },
  };
}

/**
 * The capture of a hop that was sent no memory block because rendering it again for the hop failed: the turn's
 * candidates, each included one left out with the reason `render_failed`, no tokens used, and the budget marked
 * `renderFailed` (never `reassembled`, since no block was rendered).
 *
 * @param capture - The capture of the turn's first rendering.
 * @param budget - The hop's budget.
 * @param hop - The hop's index on the turn's route.
 * @returns A new capture; `capture` is not changed.
 */
export function captureWithoutBlock(capture: MemoryRecallCapture, budget: EffectiveRecallBudget, hop: number): MemoryRecallCapture {
  const stamped = captureForHop(capture, budget, hop, false);
  return {
    ...stamped,
    budget: { ...stamped.budget, renderFailed: true },
    tokensUsed: 0,
    candidates: capture.candidates.map((candidate) =>
      candidate.outcome === 'included' ? { ...candidate, outcome: 'left_out' as const, reason: 'render_failed' as const } : candidate,
    ),
  };
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
  /**
   * A souled agent's view of the turn: on the manager of that agent's mind (`rows: 'mind'`) the content is filed
   * through the view's gate under the person's key, in place of `scopeId` and `learning`. On any other manager it is
   * not read.
   *
   * @internal
   */
  soul?: SoulTurnMemory;
}


/**
 * `text`, a memory block, with `tag` left out of each tag list its structured lines show (`| tags: a, b, c)`). A turn
 * that sends the model no user id shows the user's id among no recalled trace's tags, a trace an earlier turn or an
 * earlier release tagged with it included. A list that held `tag` alone goes with it; the stored traces are unchanged.
 *
 * @internal
 */
export function withoutShownTag(text: string, tag: string): string {
  if (!tag || !text.includes(tag)) return text;
  // A list runs from a line's last ` | tags: ` to the last `)` of the line, so an id that holds `, ` or `)` is matched
  // whole.
  return text.replace(/ \| tags: ((?:(?! \| tags: )[^\n])*)\)/g, (whole: string, list: string) => {
    const kept = withoutListItem(list, tag);
    if (kept === list) return whole;
    return kept ? ` | tags: ${kept})` : ')';
  });
}

/** `list`, a tag list joined with `, `, with each item equal to `tag` left out; `tag` may itself hold `, `. */
function withoutListItem(list: string, tag: string): string {
  const separator = ', ';
  let kept = list;
  for (;;) {
    if (kept === tag) return '';
    if (kept.startsWith(tag + separator)) {
      kept = kept.slice(tag.length + separator.length);
      continue;
    }
    if (kept.endsWith(separator + tag)) {
      kept = kept.slice(0, kept.length - separator.length - tag.length);
      continue;
    }
    const at = kept.indexOf(separator + tag + separator);
    if (at < 0) return kept;
    kept = kept.slice(0, at) + kept.slice(at + separator.length + tag.length);
  }
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
   * The query, the scopes and whether reconsolidation was skipped for each context {@link assembleContext} returned,
   * so a hop can ask again as the turn asked.
   */
  private readonly turns = new WeakMap<
    AssembledMemoryContext,
    { query: string; scopes: Array<{ scope: MemoryScope; scopeId: string }>; skipReconsolidation: boolean }
  >();

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
    /** True while the turn may send no request the user's id: its traces are not tagged with the user's id. */
    private readonly withholdsUserId: () => boolean = () => false,
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
   * Tags include the message role, active persona ID, current user ID (none on
   * a turn that sends the model no user id), and the task domain. Falsy or
   * whitespace-only values are filtered out. The
   * memory block reads the role tag 'assistant' on a trace with sourceType
   * 'agent_inference' as the agent's own earlier reply.
   *
   * @param role - The conversational role producing the content.
   * @returns A unique array of non-empty tag strings.
   */
  public buildTags(role: 'user' | 'assistant' | 'tool' | 'system'): string[] {
    const userCtx = this.getUserContext();
    const tags = [
      role,
      this.getPersonaId(),
      // The memory block shows a trace's tags to the model: a turn that sends it no user id tags nothing with one.
      this.withholdsUserId() ? undefined : userCtx?.userId,
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
   * A high-level session supplies its own key within `user`. That scope then reads the named user and session
   * keys alone, since a GMI id or the memory owner id can be another person's id.
   *
   * Where a learning layer exists (`turn.learning`) the lists are the turn's own: see
   * {@link CognitiveMemoryBridge.learnerRetrievalScopes}.
   *
   * On the manager of a souled agent's mind (`rows: 'mind'`) the list is the one scope of the turn's view of the soul
   * (`turn.soul`), the person's conversation key, whatever else the turn names; a turn with no view, or a view with no
   * key, reads nothing.
   *
   * @param turn - Session, conversation and organization of the current turn.
   * @returns A de-duplicated scope list.
   */
  public buildRetrievalScopes(
    turn?: CognitiveMemoryTurnScope,
  ): Array<{ scope: MemoryScope; scopeId: string }> {
    if (this.isMindManager()) {
      const own = turn?.soul?.scope;
      return own ? [{ scope: own.scope, scopeId: own.scopeId }] : [];
    }
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
    add('user', turn?.sessionUserScopeId ?? sessionId);
    if (!turn?.sessionUserScopeId) add('user', nonBlank(this.getGmiId()));
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
    if (!turn?.sessionUserScopeId) add('user', owner);
    for (const scope of ['thread', 'persona', 'organization'] as const) {
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
   * True when the memory manager is a souled agent's mind (`CognitiveMemoryConfig.rows` is `'mind'`): it files and
   * reads only through the turn's view of the soul.
   */
  private isMindManager(): boolean {
    try {
      return this.cognitiveMemory.getConfig?.()?.rows === 'mind';
    } catch {
      return false;
    }
  }

  /**
   * Whether the bridge files and reads through `soul`, a souled agent's view of a turn: only on the manager of that
   * agent's mind (`rows: 'mind'`). On any other manager the view is not used.
   *
   * @internal
   */
  public usesSoul(soul: SoulTurnMemory | undefined): soul is SoulTurnMemory {
    return soul !== undefined && this.isMindManager();
  }

  /** The memory manager's recall settings, or undefined when it has none or cannot be read. */
  private recallConfig(): ManagerRecallConfig | undefined {
    try {
      return this.cognitiveMemory.getConfig?.()?.recall;
    } catch {
      return undefined;
    }
  }

  /**
   * How much of each memory assembly the manager records: its `recall.capture`,
   * `'metadata'` when unset. Under `'metadata+stream'` the GMI also sends the
   * assembly's capture on its stream.
   */
  public captureMode(): RecallCaptureMode {
    return this.recallConfig()?.capture ?? 'metadata';
  }

  /**
   * Assembles a cognitive memory context suitable for injection into the LLM prompt.
   *
   * Queries the memory store for relevant traces, assembles them into a text
   * block within the manager's `recall.budget.totalTokens` (6400 tokens when
   * unset, the preamble included), and returns the assembled context.
   * Retrieval is limited to the scopes returned by
   * {@link CognitiveMemoryBridge.buildRetrievalScopes}, so a memory backend
   * shared by several sessions never surfaces another user's or another
   * session's traces in this turn's prompt.
   *
   * On the manager of a souled agent's mind the recall skips reconsolidation unless the turn's answer
   * (`turn.soulAnswer`) allows it: what the turn of a minor, or of a person who objects to profiling, reads keeps its
   * emotional context, and the access is still counted.
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
      // On a souled agent's mind, what the recall reads drifts only where the turn's answer says it may.
      const skipReconsolidation = this.isMindManager() && turn?.soulAnswer?.reconsolidation !== true;
      // The manager's recall.budget.totalTokens, 6400 when unset: the whole block, its preamble included.
      const context = await this.cognitiveMemory.assembleForPrompt(
        query,
        recallBudgetTokens(this.recallConfig()),
        this.getPadState(),
        { scopes, ...(skipReconsolidation ? { skipReconsolidation: true } : {}) },
      );
      // Changed in place: the manager renders this context again for a model hop by the object it returned.
      this.hideUserTag(context);
      if (context.contextText.trim()) {
        // Counts, the retrieval, the reranker and the absent legs; the ids only on the host's ask, the text never.
        // With the capture off, the counts come from the assembler's line report, one entry a trace.
        const capture = context.capture;
        const counted: ReadonlyArray<{ outcome: 'included' | 'left_out' }> | undefined = capture?.candidates ?? context.lineOutcomes;
        const included = counted ? counted.filter((c) => c.outcome === 'included').length : context.includedMemoryIds.length;
        const candidates = counted ? counted.length : included;
        this.addTraceEntry('DEBUG', 'Cognitive memory context assembled.', {
          tokensUsed: context.tokensUsed,
          candidates,
          included,
          leftOut: candidates - included,
          // With the capture off there is no record: the manager's setting names the recall that ran.
          retrieval: capture?.retrieval ?? this.recallConfig()?.retrieval ?? 'dense',
          reranker: capture?.reranker.provider ?? 'none',
          legsAbsent: capture ? capture.legs.filter((leg) => !leg.ran).map((leg) => ({ leg: leg.leg, ...(leg.reason ? { reason: leg.reason } : {}) })) : [],
          ...(this.recallConfig()?.traceIds === true ? { includedMemoryIds: context.includedMemoryIds } : {}),
        });
      }
      this.turns.set(context, { query, scopes, skipReconsolidation });
      return context;
    } catch (error: unknown) {
      // The error's class name only: a manager's, a vector store's or a full-text error can quote the turn's words.
      this.addTraceEntry('WARNING', 'Cognitive memory assembly failed.', { errorName: errorNameOf(error) });
      return null;
    }
  }

  /** Hide the user's tag from both the delivered block and its recorded entry formatting. */
  private hideUserTag(context: AssembledMemoryContext): void {
    if (!this.withholdsUserId()) return;
    const userId = this.getUserContext()?.userId;
    if (typeof userId !== 'string' || !userId.trim()) return;
    context.contextText = withoutShownTag(context.contextText, userId);
    if (context.renderedRecallSections) {
      context.renderedRecallSections = context.renderedRecallSections.map(({ header, entries }) => ({
        header,
        entries: entries.map((entry) => ({ ...entry, text: withoutShownTag(entry.text, userId) })),
      }));
    }
  }

  /** The configured budget of the memory block: the manager's `recall.budget.totalTokens`, 6400 when unset. */
  public budgetTokens(): number {
    return recallBudgetTokens(this.recallConfig());
  }

  /**
   * The memory block for one model hop of a turn. `context` is the turn's first rendering ({@link assembleContext}),
   * which is never changed. A hop whose budget holds it gets a copy whose capture names the hop; a hop whose budget is
   * smaller gets the block rendered again at `budget.effective`, through the manager's `reassembleForBudget` (no
   * retrieval, no embedding call), else, for a manager without that method, through `assembleForPrompt` again at that
   * budget with the turn's query and scopes. A `reassembleForBudget` that rejects is not followed by a second recall. A budget whose inputs were not valid leaves the block as it is, with one
   * `memory.recall.budget_clamped` line (`invalid`); a clamp writes one (`prompt_share`, `fixed_prompt` or `zero_remaining`), and a
   * budget of 0 also one `memory.recall.allocation_exhausted`.
   *
   * @param context - The turn's first rendering.
   * @param budget - The hop's budget (`effectiveRecallBudget` over the hop's model).
   * @param hop - The hop's index on the turn's route; 0 for the primary.
   * @returns The hop's block, or null when rendering it again failed: the hop is then sent no block. Never throws.
   */
  public async contextForHop(
    context: AssembledMemoryContext,
    budget: EffectiveRecallBudget,
    hop: number,
  ): Promise<AssembledMemoryContext | null> {
    const stamped = (c: AssembledMemoryContext, reassembled: boolean): AssembledMemoryContext =>
      c.capture ? { ...c, capture: captureForHop(c.capture, budget, hop, reassembled) } : { ...c };
    if (budget.invalid) {
      recallLog.warn('memory.recall.budget_clamped', { requested: safeInt(budget.requested), effective: safeInt(budget.effective), hop: safeInt(hop), reason: 'invalid' });
      return stamped(context, false);
    }
    if (budget.effective >= context.tokensUsed) return stamped(context, false);
    recallLog.info('memory.recall.budget_clamped', { requested: safeInt(budget.requested), effective: safeInt(budget.effective), hop: safeInt(hop), reason: budget.clampReason ?? 'prompt_share' });
    if (budget.effective === 0) {
      recallLog.warn('memory.recall.allocation_exhausted', {
        requested: safeInt(budget.requested),
        candidates: context.capture?.candidates.length ?? context.lineOutcomes?.length ?? context.includedMemoryIds.length,
      });
    }
    try {
      let next: AssembledMemoryContext;
      if (typeof this.cognitiveMemory.reassembleForBudget === 'function') {
        // A re-render that rejects sends the hop no block (the catch below): it never starts a second recall, which
        // would embed and retrieve again and could change the hop's candidates.
        next = await this.cognitiveMemory.reassembleForBudget(context, budget.effective);
      } else {
        const turn = this.turns.get(context);
        if (!turn) return null;
        next = await this.cognitiveMemory.assembleForPrompt(turn.query, budget.effective, this.getPadState(), {
          scopes: turn.scopes,
          ...(turn.skipReconsolidation ? { skipReconsolidation: true } : {}),
        });
      }
      const shown = stamped(next, true);
      this.hideUserTag(shown);
      return shown;
    } catch (error: unknown) {
      this.addTraceEntry('WARNING', 'Cognitive memory re-render for a model hop failed.', { errorName: errorNameOf(error) });
      return null;
    }
  }

  /**
   * Encodes a piece of content into the cognitive memory store.
   *
   * Fires the observer hook (if available) and encodes the content with the
   * current PAD state, mood, and derived tags.
   *
   * With `options.learning`, the trace goes under the turn's user scope id through the turn's guard, and the observer
   * is fed once the guard reports the filing kept: a refused filing, and one the guard takes back because its user was
   * forgotten while it ran, feed it nothing. A refused filing is traced with its reason, never its words.
   *
   * On the manager of a souled agent's mind (`rows: 'mind'`) the content is filed through `options.soul` alone, and
   * this resolves once the view has answered: see {@link CognitiveMemoryBridge.syncForTurn}. With no view nothing is
   * filed, and one reasoning-trace warning says so.
   *
   * @param content - The text content to encode.
   * @param options - Encoding options (type, sourceType, scopeId, role, the turn's learning, and a souled agent's view).
   */
  public async encode(content: string, options: CognitiveMemoryEncodeOptions): Promise<void> {
    if (!content.trim()) {
      return;
    }
    if (this.isMindManager()) {
      if (options.soul) {
        await this.fileThroughSoul(content, options, options.soul);
        return;
      }
      this.addTraceEntry(
        'WARNING',
        `Cognitive memory did not file the ${options.role} message: a souled agent's mind files through the turn's view of its soul alone.`,
        { role: options.role, reason: 'no_soul' },
      );
      return;
    }

    const learning = options.learning;
    const userCtx = this.getUserContext();
    const scopeId = learning ? learning.scopes.userScopeId : options.scopeId ?? userCtx.userId ?? this.getGmiId();
    const observe = async (): Promise<void> => {
      await this.cognitiveMemory.observe?.(options.role, content, this.getPadState());
    };
    const file = async (): Promise<MemoryTrace> =>
      this.cognitiveMemory.encode(content, this.getPadState(), this.getMood(), {
        type: options.type,
        scope: 'user',
        scopeId,
        sourceType: options.sourceType,
        tags: options.tags ?? this.buildTags(options.role),
        ...(learning?.turnUserId ? { turnUserId: learning.turnUserId } : {}),
      });
    try {
      if (!learning?.guard) {
        await observe();
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
      if (outcome.status === 'written') {
        await observe();
        return;
      }
      this.addTraceEntry(
        outcome.reason === 'forgotten' ? 'DEBUG' : 'WARNING',
        `Cognitive memory did not file the ${options.role} message (${outcome.reason}).`,
        { role: options.role, reason: outcome.reason },
      );
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
   *   sourceType 'agent_inference', under the tags
   *   {@link CognitiveMemoryBridge.buildTags} gives the role 'assistant'. A
   *   later turn's memory block shows it as the assistant's own earlier words,
   *   a past exchange whose content starts "You said: ", never as a fact; that is
   *   read from the sourceType and the 'assistant' tag, so a reply an earlier
   *   version filed is shown the same way.
   *
   * On the manager of a souled agent's mind (`rows: 'mind'`) with the turn's view of the soul (`soul`), the two
   * sides are filed through the view's gate under the person's key, the user's message first, and this resolves at once
   * to `{ write }`: the record of the two filings, which settles once the view has answered for each side that had
   * text, and never rejects. The turn does not wait for it, since the person's write chain can be held by a compile
   * for as long as its model call runs. On any other manager the view is not used, both sides are awaited as described
   * above, and this resolves to undefined.
   *
   * @param turnInput - The turn's input payload.
   * @param responseText - The assistant's generated response text.
   * @param learning - Where a learning layer exists: both are filed under the turn's own user scope id, each through
   *   the turn's guard.
   * @param soul - A souled agent's view of the turn.
   * @returns The record of a souled agent's filings, held in an object so that awaiting this never waits for them.
   */
  public async syncForTurn(
    turnInput: GMITurnInput,
    responseText: string,
    learning?: CognitiveMemoryTurnLearning,
    soul?: SoulTurnMemory,
  ): Promise<{ write: Promise<MemoryWriteRecord> } | undefined> {
    const inputText = this.stringifyTurnContent(turnInput.content);
    const userCtx = this.getUserContext();
    const filing = learning ? { learning } : {};
    const filesInput =
      inputText !== null &&
      (turnInput.type === GMIInteractionType.TEXT || turnInput.type === GMIInteractionType.MULTIMODAL_CONTENT);

    if (this.usesSoul(soul)) {
      // Both are started here, in order, so the person's chain runs the message before the reply.
      const sides: Array<Promise<MemoryWriteEntry>> = [];
      if (filesInput) {
        sides.push(this.fileThroughSoul(inputText, { type: 'episodic', sourceType: 'user_statement', role: 'user' }, soul));
      }
      // A view whose session decides the reply files the reply the session keeps, which a hook may give a turn whose
      // model wrote nothing.
      if (responseText.trim() || soul.keptReply === true) {
        sides.push(this.fileThroughSoul(responseText, { type: 'semantic', sourceType: 'agent_inference', role: 'assistant' }, soul));
      }
      return { write: memoryWriteRecordOf(sides) };
    }

    if (filesInput) {
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
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Starts one filing through a souled agent's view of the turn and resolves with what became of it; never rejects.
   * The view is called at once, so filings started in order reach the person's chain in that order. Its gate decides
   * what is kept: the writer it is handed stores the text the gate passes, with the emotional stamp the gate names (a
   * neutral state, or the mind's mood when the filing was started), under the view's key and marked as the mind's; a
   * trace that landed after the person was forgotten is deleted through `undo`. The observer hears the kept text once
   * the entry says it was written, and nothing otherwise; the entry does not wait for it. A view with no key files
   * nothing (`no_subject`). A failed or skipped side is traced with its error's class name or its reason, never its
   * words.
   *
   * @param content - The side's text.
   * @param options - Its type, source and role; the role `'user'` files as the person's message, any other as the
   *   agent's own words.
   * @param soul - The turn's view of the soul.
   */
  private fileThroughSoul(content: string, options: CognitiveMemoryEncodeOptions, soul: SoulTurnMemory): Promise<MemoryWriteEntry> {
    const role: 'user' | 'assistant' = options.role === 'user' ? 'user' : 'assistant';
    const own = soul.scope;
    if (!own) {
      const entry: MemoryWriteEntry = { role, outcome: 'skipped', reason: 'no_subject' };
      this.traceSoulEntry(entry);
      return Promise.resolve(entry);
    }
    // Read when the filing starts: the person's chain may reach the write after the next turn has changed them.
    const pad = this.getPadState();
    const mood = this.getMood();
    const tags = options.tags ?? this.buildTags(options.role);
    let kept: { text: string; pad: PADState } | undefined;
    const write = async (filing: SoulFiling): Promise<MemoryTrace> => {
      const stamped = filing.stamp === 'mood';
      const filedPad: PADState = stamped ? pad : { ...NEUTRAL_PAD };
      const trace = await this.cognitiveMemory.encode(filing.text, filedPad, stamped ? mood : GMIMood.NEUTRAL, {
        type: options.type,
        scope: 'conversation',
        scopeId: own.scopeId,
        sourceType: options.sourceType,
        tags,
        filing: filing.filing,
        ...(filing.turnUserId ? { turnUserId: filing.turnUserId } : {}),
      });
      kept = { text: filing.text, pad: filedPad };
      return trace;
    };
    const undo = async (trace: MemoryTrace): Promise<void> => {
      if (typeof this.cognitiveMemory.deleteTraces !== 'function') {
        throw new Error('the memory manager has no deleteTraces');
      }
      await this.cognitiveMemory.deleteTraces([trace.id]);
    };
    let filed: Promise<unknown>;
    try {
      filed = Promise.resolve(soul.file(role, content, write, undo));
    } catch (error: unknown) {
      filed = Promise.reject(error);
    }
    return filed.then(
      async (answer) => {
        // The view's answer as the record keeps it: the side's own role, and nothing else the view put on it.
        const entry = writeEntryOf(role, answer) ?? failedWriteEntry(role, new TypeError('the soul gave no write entry'));
        if (entry.outcome === 'written' && kept) {
          // Started here and not awaited: the record settles on the gate's answer, never on the observer's model call.
          void this.observeKept(options.role, kept.text, kept.pad, role).catch(() => undefined);
        } else if (entry.outcome !== 'written') {
          this.traceSoulEntry(entry);
        }
        return entry;
      },
      (error: unknown) => {
        const entry = failedWriteEntry(role, error);
        this.traceSoulEntry(entry);
        return entry;
      },
    );
  }

  /**
   * Feeds the observer the text a souled agent's gate kept. It is called at once and never rejects: a failure is one
   * reasoning-trace warning with the error's class name.
   */
  private async observeKept(observedRole: CognitiveMemoryEncodeOptions['role'], text: string, pad: PADState, role: 'user' | 'assistant'): Promise<void> {
    try {
      await this.cognitiveMemory.observe?.(observedRole, text, pad);
    } catch (error: unknown) {
      this.addTraceEntry('WARNING', 'Cognitive memory observation failed.', { role, errorName: errorNameOf(error) });
    }
  }

  /** A reasoning-trace entry for a side the soul's gate did not file: its reason, or its error's class name. */
  private traceSoulEntry(entry: MemoryWriteEntry): void {
    if (entry.outcome === 'failed') {
      this.addTraceEntry('WARNING', 'Cognitive memory encoding failed.', { role: entry.role, errorName: entry.errorName });
    } else if (entry.outcome === 'skipped') {
      this.addTraceEntry('DEBUG', `Cognitive memory did not file the ${entry.role} message (${entry.reason}).`, {
        role: entry.role,
        reason: entry.reason,
      });
    }
  }

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
