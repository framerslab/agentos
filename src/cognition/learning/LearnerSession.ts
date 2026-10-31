/**
 * @module learning/LearnerSession
 *
 * One session's view of the learning layer. A session belongs to the user of its first turn and to the namespace the
 * host opened it under: a turn of another user or another namespace, and every turn after it, has no learner. A
 * learner's turn renders the learner's kept traits from the trait row the layer checked at load; a turn with
 * no learner, a turn in mode `off`, a learner whose record does not verify and a store that cannot be read render the
 * persona's authored traits. Every turn gets the scope ids it files and reads its memory under (`scopes.ts`), and
 * a turn with no learner whose user is explicit gets that user's id (`turnUserId`), so `forgetUser` for that user finds
 * what the turn wrote. A write into a learner's own session that names no other user (a workflow turn of the learner,
 * the learner's turn after another user's) is the learner's: the learner's deletion takes the session's own form. The
 * session records the memory writes of the memory tools and the rolling-summary sink
 * (`recordSelfChange`: a `pending` row, the write, the tombstone read again, the verdict) and guards the bridge's own
 * filing (`guardMemoryWrite`), each inside its user's write chain, so `forgetUser`, which takes the same chain,
 * deletes only after every write this process admitted before it has reached its verdict.
 */
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import {
  HEXACO_TRAIT_KEYS,
  normalizeHexacoTraits,
  type HexacoTraitKey,
  type HexacoTraitValues,
} from '../substrate/personas/hexaco.js';
import {
  applyTraitOverlay,
  droppedTraitPatchWarning,
  OPERATOR_ONLY_TRAITS,
  PERSONALITY_PROMPT_PRIORITY,
  renderPersonalitySection,
  type TraitBand,
} from '../substrate/personas/personalityPrompt.js';
import { processIsFrozen, resolveTurnMode } from './config.js';
import type { FreezeTarget } from './hostCalls.js';
import { tombstoneHash, type DecideResult, type Ledger, type ProposeResult } from './ledger/Ledger.js';
import { learnerScopeIds, sessionScopeIds } from './scopes.js';
import type { LearningStore } from './store/LearningStore.js';
import { loadLearnerTraits, type TraitLoad } from './traitLoad.js';
import { renderedTraits } from './traitState.js';
import type {
  GuardedMemoryWrite,
  ILearnerSession,
  LearnerContext,
  LearnerKey,
  LearningMode,
  LedgerLearner,
  NoLearnerReason,
  ProposalResult,
  SelfChangeTurn,
  SessionSelfChange,
  TurnInputForLearning,
  TurnPreparation,
  TurnScopes,
} from './types.js';
import { sessionChainKey, userChainKey, type WriteChains } from './writeChains.js';

/** What a learner session reads from the layer that made it. */
export interface LearnerSessionHost {
  /** A turn's mode for a scope: the configured mode, the process switches, then the scope's suspensions and freezes. */
  modeFor(target: FreezeTarget): LearningMode;
  /** Whether a freeze holds for a scope now, whatever the mode: the config, the process switch or a run-time freeze. */
  frozenFor(target: FreezeTarget): boolean;
  /** Counts one prepared turn; `reason` says why it has no learner, when it has none. */
  countTurn(reason: NoLearnerReason | undefined): void;
  /** Reads the run-time freezes and suspensions again; keeps the last read when the store cannot be read. */
  refreshFreezes(): Promise<void>;
  /** The store and the ledger, opening the store if it has not opened; `undefined` while it cannot. */
  storage(): Promise<{ store: LearningStore; ledger: Ledger } | undefined>;
  /** The layer's write chains, one per user and per session. */
  readonly chains: WriteChains;
  /** The candidates whose write this process is making now; a crash's recovery leaves them to their writer. */
  readonly inFlight: Set<string>;
  /** Whether a user id names no user: blank, or one of the anonymous ids. */
  isAnonymous(userId: string): boolean;
  /** The namespace of a turn whose own is `''`: `learning.namespace` on `gmi()`, else `''`. */
  readonly defaultNamespace: string;
  /** The layer's clock, in milliseconds since the epoch. */
  now(): number;
  /** Advanced when an operator call of this process changes a learner's trait row: a session reads its row again. */
  traitEpoch(key: LearnerKey): number;
  /** Records whether a learner's record verifies, for the manifest. */
  noteChain(key: LearnerKey, broken: boolean): void;
  /** Deletes every learning-store row of a user in one namespace again: a write found the tombstone once it committed. */
  purgeUserRows(namespace: string, userId: string): Promise<void>;
  /** Re-files a memory manager's Brain once and keeps the manager for `forgetUser`. */
  adoptMemory(memory: ICognitiveMemoryManager): Promise<void>;
}

/**
 * Who a session belongs to: its learner and the namespace the host opened it under (before the layer fills
 * `learning.namespace` into the key), or why it has no learner.
 */
export type SessionBinding = { key: LearnerKey; openedUnder: string } | { reason: NoLearnerReason };

/** What one recorded or guarded write is keyed to. */
interface WriteTarget {
  /** The ledger row's learner: the session's learner on a learner's turn, else the agent with no user. */
  learner: LedgerLearner;
  /**
   * On a turn with no learner: the user whose turn it is (an explicit second user's id), or, for a write into the
   * session's own form of a learner's session, the session's learner, whose deletion takes that form.
   */
  turnUserId?: string;
  /** The user whose tombstone the write reads and whose session row it notes; none for a write that names no user. */
  user?: { namespace: string; userId: string; kind: 'learner' | 'visitor' };
  /** The write chain the write holds from its admission to its verdict. */
  chainKey: string;
  conversationId?: string;
  /** The scope whose freeze and mode the write reads. */
  target: FreezeTarget;
}

type GuardResult<T> =
  | { status: 'written'; result: T }
  | { status: 'rejected'; reason: 'forgotten' | 'store_unavailable' };

type LoadedTraits = Extract<TraitLoad, { status: 'ok' }>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The brain a memory manager files into, when it has a Brain. */
function brainIdOf(memory: ICognitiveMemoryManager | undefined): string | undefined {
  try {
    const store = memory?.getStore?.() as { getBrain?: () => { brainId?: unknown } | null } | undefined;
    const brainId = store?.getBrain?.()?.brainId;
    return typeof brainId === 'string' && brainId !== '' ? brainId : undefined;
  } catch {
    return undefined;
  }
}

/** What a write touched: the brain it went to and the traces it names, for the line about a write not taken back. */
interface Touched {
  brainId?: string;
  traceIds?: readonly string[];
  /** A recorded write, whose `pending` ledger row stays when it is not taken back. */
  recorded?: boolean;
}

/** The trace ids a recorded write names: those it creates, changes and deletes. */
function traceIdsOf(after: SessionSelfChange['after'] | undefined): string[] {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const changed = list(after?.changed).map((change) => (change && typeof change === 'object' ? (change as { id?: unknown }).id : undefined));
  const ids = [...list(after?.created), ...changed, ...list(after?.deleted)];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

/** Where what a write wrote lies: its brain and its traces, as far as the session knows them. */
function placeOf(touched: Touched): string {
  const traces = touched.traceIds?.length ? ` (traces ${touched.traceIds.join(', ')})` : '';
  return touched.brainId ? `brain ${touched.brainId}${traces}` : `the memory store it was written to${traces}`;
}

export class LearnerSession implements ILearnerSession {
  private readonly key: LearnerKey | undefined;
  /** The registry persona's authored traits. */
  private readonly authored: HexacoTraitValues;
  /** A role overlay's patch of the four learnable traits, rendered for this session only. */
  private readonly overlay: HexacoTraitValues | undefined;
  /** The authored traits with the overlay's patch: what a turn with no learner renders. */
  private readonly authoredTraits: HexacoTraitValues;
  private readonly authoredSection: string | null;
  /** The brain of the session's memory manager, which the bridge files into. */
  private readonly brainId: string | undefined;
  /** Set by the first turn of another user or namespace; no turn after it has a learner. */
  private lostLearner: NoLearnerReason | undefined;
  /** The namespace of the last turn read: a write that names no turn is filed under it. */
  private lastNamespace: string;
  private traits: TraitLoad | undefined;
  private traitsEpoch = -1;
  private loading: Promise<void> | undefined;
  private learnerRowWritten = false;
  private lastTraits: HexacoTraitValues;

  /**
   * @param host - The layer.
   * @param binding - The learner and the namespace the session was opened under, or why it has none.
   * @param context - The session: its persona's authored traits, a role overlay's patch, its memory manager.
   * @param agentKey - The agent a write with no learner is recorded under.
   */
  constructor(
    private readonly host: LearnerSessionHost,
    private readonly binding: SessionBinding,
    private readonly context: LearnerContext,
    private readonly agentKey: string,
  ) {
    this.key = 'key' in binding ? binding.key : undefined;
    this.lastNamespace = 'key' in binding ? binding.openedUnder : '';
    this.authored = normalizeHexacoTraits(context.authoredTraits);
    const { traits, dropped } = applyTraitOverlay(this.authored, context.overlayTraits);
    this.authoredTraits = traits;
    this.authoredSection = renderPersonalitySection(traits);
    const patch = normalizeHexacoTraits(context.overlayTraits);
    const learnable: HexacoTraitValues = {};
    for (const key of HEXACO_TRAIT_KEYS) {
      if (patch[key] !== undefined && !OPERATOR_ONLY_TRAITS.includes(key)) learnable[key] = patch[key];
    }
    this.overlay = Object.keys(learnable).length > 0 ? learnable : undefined;
    this.brainId = brainIdOf(context.memory);
    this.lastTraits = traits;
    if (dropped.length > 0) {
      console.warn(`[agentos] learning: ${droppedTraitPatchWarning(context.personaId, dropped)}`);
    }
  }

  /**
   * What the layer does when it opens the session: re-files the memory manager's Brain once and, for a learner,
   * hydrates the learner's two scopes and writes the learner's session row, in every mode, and loads the trait row
   * where the mode reads learned state (`on` and `frozen`). Never throws: what fails is traced and tried again at the
   * next turn.
   */
  async open(): Promise<void> {
    if (this.context.memory) await this.host.adoptMemory(this.context.memory);
    if (!this.key) return;
    await this.hydrate(this.key);
    await this.writeLearnerRow();
    if (this.host.modeFor(this.targetFor(true)) !== 'off') {
      await this.loadTraits();
      if (this.traits?.status === 'ok') this.lastTraits = this.learnerRender(this.traits).traits;
    }
  }

  async prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation> {
    const reason = this.noLearnerReasonFor(input);
    this.host.countTurn(reason);
    await this.host.refreshFreezes();
    const bound = reason === undefined;
    const mode = this.host.modeFor(this.targetFor(bound));
    if (this.key && !this.learnerRowWritten) await this.writeLearnerRow();
    let section = this.authoredSection;
    let traits = this.authoredTraits;
    if (bound && mode !== 'off') {
      if (this.traitsStale()) await this.loadTraits();
      if (this.traits?.status === 'ok') ({ section, traits } = this.learnerRender(this.traits));
    }
    this.lastTraits = traits;
    const turnUserId = bound ? undefined : this.visitorOf(input);
    return {
      systemPrompts: section ? [{ content: section, priority: PERSONALITY_PROMPT_PRIORITY, source: 'learning:personality' }] : [],
      learner: bound ? 'bound' : 'none',
      ...(reason ? { noLearnerReason: reason } : {}),
      mode,
      scopes: this.scopesOf(bound, input.namespace, mode),
      ...(turnUserId ? { turnUserId } : {}),
    };
  }

  scopesFor(turn: { userId: string | null; namespace: string; workflowSeat: boolean }): TurnScopes {
    const bound = this.noLearnerReasonFor(turn) === undefined;
    return this.scopesOf(bound, turn.namespace, this.host.modeFor(this.targetFor(bound)));
  }

  isFrozen(turn?: SelfChangeTurn): boolean {
    return this.host.frozenFor(this.writeOf(turn).target);
  }

  /**
   * Takes the loss of the learner that a deferred session saw on a turn it could not open for
   * ({@link deferLearnerSession}): no turn of this session has a learner from now on, as if the session had been open
   * at that turn, and the layer counts each such turn under the reason. A session with no learner keeps its own
   * reason. A host's own session that has a method of this name and shape takes the loss the same way.
   *
   * @param reason - Why the turn the deferred session saw has no learner.
   */
  adoptLatch(reason: 'other_user' | 'other_namespace'): void {
    if ('reason' in this.binding || this.lostLearner) return;
    this.lostLearner = reason;
  }

  recordSelfChange<T>(input: SessionSelfChange<T>, turn?: SelfChangeTurn): Promise<ProposalResult<T>> {
    const write = this.writeOf(turn);
    return this.host.chains.run(write.chainKey, () => this.recordInChain(input, write));
  }

  guardMemoryWrite<T>(input: GuardedMemoryWrite<T>, turn?: SelfChangeTurn): Promise<GuardResult<T>> {
    const write = this.writeOf(turn);
    return this.host.chains.run(write.chainKey, async (): Promise<GuardResult<T>> => {
      // A write that names no user has no tombstone to read and no deletion to miss it.
      if (!write.user) return { status: 'written', result: await input.apply() };
      const storage = await this.host.storage();
      if (!storage) return { status: 'rejected', reason: 'store_unavailable' };
      try {
        if ((await this.noteSession(storage.store, write, this.brainId)) === 'forgotten') {
          return { status: 'rejected', reason: 'forgotten' };
        }
      } catch {
        return { status: 'rejected', reason: 'store_unavailable' };
      }
      const result = await input.apply();
      const after = await this.tombstoneAfter(storage.store, write);
      if (after !== 'clear') {
        const gone = await this.takeBack(storage.store, input.undo, result, write, after === 'forgotten', { brainId: this.brainId });
        return { status: 'rejected', reason: gone ? 'forgotten' : 'store_unavailable' };
      }
      return { status: 'written', result };
    });
  }

  /** Nothing to flush: every write commits as it is made. */
  async endSession(): Promise<void> {}

  /** The traits the session's last prepared turn rendered; before its first turn, a learner's kept traits where loaded. */
  currentTraits(): HexacoTraitValues {
    return { ...this.lastTraits };
  }

  /**
   * Why this turn has no learner, or `undefined` when it has one. Every turn is read against the session's user and
   * namespace first, a workflow turn included, so a turn of another user or namespace ends the session's learner
   * whatever else it is. A tool continuation carries the GMI's own user (the GMI builds its input), so only its
   * namespace is read: a continuation under another organization (a resume whose host passed one) ends it too.
   */
  private noLearnerReasonFor(
    input: Pick<TurnInputForLearning, 'userId' | 'namespace' | 'workflowSeat' | 'continuation'>,
  ): NoLearnerReason | undefined {
    this.lastNamespace = input.namespace ?? '';
    if ('reason' in this.binding) return this.binding.reason;
    if (!this.lostLearner) {
      if (!input.continuation && input.userId !== this.binding.key.userId) {
        this.lostLearner = 'other_user';
      } else if ((input.namespace ?? '') !== this.binding.openedUnder) {
        this.lostLearner = 'other_namespace';
      }
    }
    if (this.lostLearner) return this.lostLearner;
    return input.workflowSeat ? 'workflow_seat' : undefined;
  }

  /** The namespace a turn's session form and its writes use: its own, else the agent's (`learning.namespace`). */
  private namespaceOf(turnNamespace: string | undefined): string {
    return (turnNamespace ?? '') || this.host.defaultNamespace;
  }

  private scopesOf(bound: boolean, turnNamespace: string | undefined, mode: LearningMode): TurnScopes {
    if (bound && this.key) {
      const { userScopeId, personaScopeId } = learnerScopeIds(this.key, this.context.personaId);
      return { learner: 'bound', mode, userScopeId, personaScopeId, namespace: this.key.namespace };
    }
    const namespace = this.namespaceOf(turnNamespace);
    const { userScopeId, personaScopeId } = sessionScopeIds(this.context.sessionId, namespace, this.context.personaId);
    return { learner: 'none', mode, userScopeId, personaScopeId, namespace };
  }

  /**
   * On a turn with no learner, the user its writes record: the turn's own id when it is explicit, outside the
   * anonymous ids and not the session's learner in the learner's namespace. A tool continuation records none.
   */
  private visitorOf(input: Pick<TurnInputForLearning, 'userId' | 'namespace' | 'continuation'>): string | undefined {
    if (input.continuation) return undefined;
    const userId = input.userId;
    if (typeof userId !== 'string' || this.host.isAnonymous(userId)) return undefined;
    if (this.key && userId === this.key.userId && this.namespaceOf(input.namespace) === this.key.namespace) return undefined;
    return userId;
  }

  private targetFor(bound: boolean): FreezeTarget {
    return bound && this.key ? { agentKey: this.agentKey, learner: this.key } : { agentKey: this.agentKey };
  }

  /** What a write is keyed to: the turn it belongs to, or, without one, the session's own state. */
  private writeOf(turn?: SelfChangeTurn): WriteTarget {
    const bound = turn ? turn.learner === 'bound' && this.key !== undefined : this.key !== undefined && !this.lostLearner;
    const conversation = turn?.conversationId ? { conversationId: turn.conversationId } : {};
    if (bound) {
      const key = this.key!;
      return {
        learner: { namespace: key.namespace, agentKey: key.agentKey, userId: key.userId },
        user: { namespace: key.namespace, userId: key.userId, kind: 'learner' },
        chainKey: userChainKey(key.namespace, key.userId),
        ...conversation,
        target: this.targetFor(true),
      };
    }
    const namespace = this.namespaceOf(turn ? turn.namespace : this.lastNamespace);
    const visitor = turn?.turnUserId && !this.host.isAnonymous(turn.turnUserId) ? turn.turnUserId : undefined;
    // A write that names no other user, into the session's own form of a learner's session in the learner's namespace
    // (a workflow turn of the learner, the learner's turn after another user's), is the learner's: forgetUser deletes
    // that form with the learner's sessions, so the write reads the learner's tombstone inside the learner's write chain
    // and its row names the learner, which the learner's deletion takes with the learner's other rows.
    const owner = visitor === undefined && this.key && namespace === this.key.namespace ? this.key.userId : undefined;
    const turnUserId = visitor ?? owner;
    const kind = this.key && turnUserId === this.key.userId && namespace === this.key.namespace ? 'learner' : 'visitor';
    return {
      learner: { namespace, agentKey: this.agentKey, userId: null },
      ...(turnUserId ? { turnUserId, user: { namespace, userId: turnUserId, kind } } : {}),
      chainKey: turnUserId ? userChainKey(namespace, turnUserId) : sessionChainKey(this.context.sessionId),
      ...conversation,
      target: this.targetFor(false),
    };
  }

  /** The learner's kept traits, with the overlay's patch, and the section they render, holding the row's bands. */
  private learnerRender(loaded: LoadedTraits): { section: string | null; traits: HexacoTraitValues } {
    const kept = renderedTraits(loaded.state, this.authored, loaded.operator);
    if (!this.overlay) return { section: renderPersonalitySection(kept, { bands: loaded.state.bands }), traits: kept };
    const traits: HexacoTraitValues = { ...kept, ...this.overlay };
    const bands: Partial<Record<HexacoTraitKey, TraitBand>> = { ...loaded.state.bands };
    for (const key of Object.keys(this.overlay) as HexacoTraitKey[]) delete bands[key];
    return { section: renderPersonalitySection(traits, { bands }), traits };
  }

  private traitsStale(): boolean {
    return !this.traits || this.traits.status === 'unavailable' || this.traitsEpoch !== this.host.traitEpoch(this.key!);
  }

  private loadTraits(): Promise<void> {
    this.loading ??= this.readTraits().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async readTraits(): Promise<void> {
    const key = this.key!;
    const epoch = this.host.traitEpoch(key);
    const storage = await this.host.storage();
    if (!storage) {
      // The layer traced why the store did not open.
      this.traits = { status: 'unavailable', reason: 'the learning store did not open' };
      return;
    }
    try {
      this.traits = await loadLearnerTraits({
        store: storage.store,
        ledger: storage.ledger,
        key,
        personaId: this.context.personaId,
        authored: this.authored,
        sessionId: this.context.sessionId,
        now: () => this.host.now(),
      });
    } catch (error) {
      this.traits = { status: 'unavailable', reason: messageOf(error) };
      console.warn(`[agentos] learning: a learner's trait row could not be read (${this.traits.reason}); the persona's authored traits render, and the next turn reads it again.`);
    }
    this.traitsEpoch = epoch;
    // A read that failed says nothing of the record: a learner counted as broken stays counted until a read verifies it.
    if (this.traits.status !== 'unavailable') this.host.noteChain(key, this.traits.status === 'broken');
    if (this.traits.status === 'broken') {
      console.warn(
        `[agentos] learning: the learning record of learner '${key.userId}' of agent '${key.agentKey}' in namespace '${key.namespace}' does not verify (${this.traits.reason}); the persona's authored traits render until an operator calls operatorSet.`,
      );
    }
  }

  /** Loads the learner's two scopes into the memory manager, past the whole Brain's newest 1,000 traces. */
  private async hydrate(key: LearnerKey): Promise<void> {
    let store: { hydrateScope?: (scope: 'user' | 'persona', scopeId: string) => Promise<number> } | undefined;
    try {
      store = this.context.memory?.getStore?.() as typeof store;
    } catch {
      return;
    }
    if (typeof store?.hydrateScope !== 'function') return;
    const { userScopeId, personaScopeId } = learnerScopeIds(key, this.context.personaId);
    try {
      await store.hydrateScope('user', userScopeId);
      await store.hydrateScope('persona', personaScopeId);
    } catch (error) {
      console.warn(`[agentos] learning: a learner's memory did not hydrate (${messageOf(error)}); the turn proceeds with what is loaded.`);
    }
  }

  /** The learner's row of the sessions table, the index `forgetUser` deletes by; written in every mode. */
  private async writeLearnerRow(): Promise<void> {
    if (this.learnerRowWritten || !this.key) return;
    const key = this.key;
    const write = this.writeOf({ learner: 'bound', namespace: key.namespace });
    await this.host.chains.run(write.chainKey, async () => {
      const storage = await this.host.storage();
      if (!storage) return;
      try {
        // A forgotten learner gets no row, and a row a deletion of another process missed is deleted again.
        await this.noteSession(storage.store, write, this.brainId);
        this.learnerRowWritten = true;
      } catch (error) {
        console.warn(`[agentos] learning: a learner's session row was not written (${messageOf(error)}); the next turn writes it.`);
      }
    });
  }

  /**
   * Adds a write's brain and conversation to its user's session row (the learner's, or the visitor's, written at that
   * user's first write on the session), in a store transaction that reads the tombstone first, so a forgotten user
   * gets no row. The row is written at the version this transaction read it at, so a write of it another process
   * committed in that time is never written over: the row is read and noted again, up to three times. Once a note has
   * committed the tombstone is read again: a `forgetUser` of another process that committed its tombstone while the
   * note ran deleted the user's rows without this one, so the user's rows are deleted again and the write is refused.
   *
   * @throws {Error} When the store fails, or the row kept moving under three notes: the write is refused.
   */
  private async noteSession(store: LearningStore, write: WriteTarget, brainId: string | undefined): Promise<'noted' | 'forgotten'> {
    const user = write.user;
    if (!user) return 'noted';
    const tomb = await tombstoneHash(user.namespace, user.userId);
    const agentKey = user.kind === 'learner' ? this.key!.agentKey : this.agentKey;
    const sessionId = this.context.sessionId;
    const holds = (row: { brainIds: string[]; conversationIds: string[] } | undefined): boolean =>
      !!row &&
      (!brainId || row.brainIds.includes(brainId)) &&
      (!write.conversationId || row.conversationIds.includes(write.conversationId));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await store.transaction(async (tx): Promise<'held' | 'written' | 'forgotten'> => {
        if (await tx.isForgotten(tomb)) return 'forgotten';
        const current = await tx.sessionRow(user.namespace, agentKey, sessionId, user.userId, user.kind);
        if (holds(current)) return 'held';
        await tx.putSessionRow({
          namespace: user.namespace,
          agentKey,
          sessionId,
          userId: user.userId,
          kind: user.kind,
          personaId: current?.personaId ?? this.context.personaId,
          conversationIds: [...new Set([...(current?.conversationIds ?? []), ...(write.conversationId ? [write.conversationId] : [])])],
          brainIds: [...new Set([...(current?.brainIds ?? []), ...(brainId ? [brainId] : [])])],
          startedAt: current?.startedAt ?? new Date(this.host.now()).toISOString(),
          version: (current?.version ?? 0) + 1,
        }, current?.version ?? 0);
        return 'written';
      });
      if (outcome === 'forgotten') return outcome;
      if (outcome === 'held') return 'noted';
      if (await store.isForgotten(tomb)) {
        await this.host.purgeUserRows(user.namespace, user.userId);
        return 'forgotten';
      }
      // A note another process committed after this one read the row left this one unwritten: it is made again.
      if (holds(await store.sessionRow(user.namespace, agentKey, sessionId, user.userId, user.kind))) return 'noted';
    }
    throw new Error('the session row kept moving under three notes');
  }

  /** The tombstone read again once a write has committed. */
  private async tombstoneAfter(store: LearningStore, write: WriteTarget): Promise<'clear' | 'forgotten' | 'unreadable'> {
    if (!write.user) return 'clear';
    try {
      return (await store.isForgotten(await tombstoneHash(write.user.namespace, write.user.userId))) ? 'forgotten' : 'clear';
    } catch {
      return 'unreadable';
    }
  }

  /**
   * Takes back a write that finished after its user was forgotten, whose tombstone could not be read again or whose
   * verdict did not land, and, for a forgotten user, deletes the user's learning rows once more. The writer's `undo` is
   * told which (`forgotten` deletes for good; `unrecorded` restores the before-state). The tombstone is read before an
   * `unrecorded` undo and again once it has run: a `forgetUser` of another process, which this process's write chain
   * does not order, may have deleted the user's traces meanwhile, and a restore would bring back the words it removed,
   * so a write whose user is forgotten by then is taken back for good. A line about a forgotten user names the
   * tombstone's hash and where the write lies, never the user.
   *
   * @returns Whether the write was taken back for good, its user forgotten.
   */
  private async takeBack<T>(
    store: LearningStore,
    undo: (result: T, reason: 'forgotten' | 'unrecorded') => Promise<void>,
    result: T,
    write: WriteTarget,
    forgotten: boolean,
    touched: Touched,
  ): Promise<boolean> {
    if (!forgotten && (await this.tombstoneAfter(store, write)) !== 'forgotten') {
      await this.undoWrite(undo, result, 'unrecorded', write, touched);
      if ((await this.tombstoneAfter(store, write)) !== 'forgotten') return false;
    }
    await this.undoWrite(undo, result, 'forgotten', write, touched);
    if (write.user) await this.host.purgeUserRows(write.user.namespace, write.user.userId);
    return true;
  }

  /** Runs a writer's `undo`; one that fails is traced with where the write lies, and never fails the call. */
  private async undoWrite<T>(
    undo: (result: T, reason: 'forgotten' | 'unrecorded') => Promise<void>,
    result: T,
    reason: 'forgotten' | 'unrecorded',
    write: WriteTarget,
    touched: Touched,
  ): Promise<void> {
    try {
      await undo(result, reason);
    } catch (error) {
      if (reason === 'forgotten' && write.user) {
        const hash = (await tombstoneHash(write.user.namespace, write.user.userId)).slice(0, 16);
        console.warn(
          `[agentos] learning: a memory write that finished after its user was forgotten (tombstone ${hash}) was not taken back (${messageOf(error)}); what it wrote stays in ${placeOf(touched)} until it is deleted there.`,
        );
      } else {
        const row = touched.recorded ? '; its pending ledger row stays to be decided by whether the write holds' : '';
        console.warn(
          `[agentos] learning: a memory write whose record could not be completed was not taken back (${messageOf(error)}); it stays in ${placeOf(touched)}${row}.`,
        );
      }
    }
  }

  private async recordInChain<T>(input: SessionSelfChange<T>, write: WriteTarget): Promise<ProposalResult<T>> {
    // Only a freeze stops a memory write; a suspension and mode off leave memory as the host configured it.
    if (this.host.frozenFor(write.target)) return { status: 'rejected', reason: 'frozen' };
    const storage = await this.host.storage();
    if (!storage) return { status: 'rejected', reason: 'store_unavailable' };
    const { store, ledger } = storage;
    try {
      if ((await this.noteSession(store, write, input.brainId)) === 'forgotten') return { status: 'rejected', reason: 'forgotten' };
    } catch (error) {
      return { status: 'rejected', reason: 'store_unavailable', error };
    }
    if (this.host.modeFor(write.target) === 'off') return this.writeUnrecorded(input, write, store);
    let proposed: ProposeResult;
    try {
      proposed = await ledger.propose({
        learner: write.learner,
        kind: 'memory_write',
        actor: input.actor,
        subject: input.subject,
        before: input.before,
        after: { brainId: input.brainId, ...input.after },
        sessionId: this.context.sessionId,
        ...(write.turnUserId ? { turnUserId: write.turnUserId } : {}),
      });
    } catch (error) {
      return { status: 'rejected', reason: 'store_unavailable', error };
    }
    if (!('candidate' in proposed)) return { status: 'rejected', reason: proposed.status };
    const ledgerId = proposed.candidate.id;
    const touched: Touched = { brainId: input.brainId, traceIds: traceIdsOf(input.after), recorded: true };
    this.host.inFlight.add(ledgerId);
    try {
      let result: T;
      try {
        result = await input.apply();
      } catch (error) {
        await ledger.decide(ledgerId, 'rejected', 'write_failed').catch((decideError: unknown) => {
          console.warn(`[agentos] learning: a failed memory write's verdict was not written (${messageOf(decideError)}); its pending row is decided at the learner's next load.`);
        });
        return { status: 'rejected', reason: 'write_failed', ledgerId, error };
      }
      const after = await this.tombstoneAfter(store, write);
      if (after !== 'clear') {
        const gone = await this.takeBack(store, input.undo, result, write, after === 'forgotten', touched);
        return gone ? { status: 'rejected', reason: 'forgotten' } : { status: 'rejected', reason: 'store_unavailable', ledgerId };
      }
      let decided: DecideResult;
      try {
        decided = await ledger.decide(ledgerId, 'kept', 'written');
      } catch (error) {
        // A change with no record does not happen: the write is taken back and its pending row stays to be decided.
        const gone = await this.takeBack(store, input.undo, result, write, false, touched);
        return gone ? { status: 'rejected', reason: 'forgotten' } : { status: 'rejected', reason: 'store_unavailable', ledgerId, error };
      }
      if (decided.status === 'kept') return { status: 'kept', ledgerId, result };
      // The verdict did not land: the user forgotten meanwhile (the chain's head marked, or the candidate deleted with
      // the user's rows by another process), another verdict first, or a head that kept moving. The tombstone decides
      // how the write is taken back.
      const gone = await this.takeBack(store, input.undo, result, write, decided.status === 'forgotten', touched);
      return gone ? { status: 'rejected', reason: 'forgotten' } : { status: 'rejected', reason: 'conflict', ledgerId };
    } finally {
      this.host.inFlight.delete(ledgerId);
    }
  }

  /** Mode `off` and a suspension: the write is made with no ledger row, its tombstone read before and after. */
  private async writeUnrecorded<T>(input: SessionSelfChange<T>, write: WriteTarget, store: LearningStore): Promise<ProposalResult<T>> {
    let result: T;
    try {
      result = await input.apply();
    } catch (error) {
      return { status: 'rejected', reason: 'write_failed', error };
    }
    const after = await this.tombstoneAfter(store, write);
    if (after !== 'clear') {
      const touched: Touched = { brainId: input.brainId, traceIds: traceIdsOf(input.after) };
      const gone = await this.takeBack(store, input.undo, result, write, after === 'forgotten', touched);
      return { status: 'rejected', reason: gone ? 'forgotten' : 'store_unavailable' };
    }
    return { status: 'written', result };
  }
}

/**
 * A learner session whose learner is named at its first turn: the full runtime's GMIs built where the turn's
 * organization is not known yet (a GMI built again for a tool-result resume), and a session whose open failed. The
 * session is opened under the namespace its first turn carries, on every attempt, and every later turn is read against
 * it. A turn the open failed for is read against the first one as the opened session reads it (a tool continuation
 * carries the GMI's own user, so only its namespace is read): the first such turn of another user or another namespace
 * is remembered, and once the session opens no turn has a learner. The first user the session saw is read by the
 * opened session against its own learner as it opens, so a turn of another user that came first ends its learner. A turn the opened session prepares, one that waited
 * on the same open included, is read by the session itself, in the order the turns came. A session that cannot take
 * the loss ({@link LearnerSession.adoptLatch}, a host's own that has no `adoptLatch`) has its later turns answered with
 * no learner here: a turn it would bind renders the authored traits and files under the session's own form. Before
 * it opens it answers `scopesFor` with the session's own form and no learner, and its recorder and guard try the open
 * and refuse (`store_unavailable`) while it fails.
 *
 * @param args.open - Opens the session for the first turn's namespace. A failed open is tried again at the next call,
 *   under the same namespace.
 * @param args.traits - The persona's authored traits: what `currentTraits()` answers before the session is open, and
 *   what a turn answered here with no learner renders.
 * @param args.sessionId - With `personaId`, lets the session answer `scopesFor` before it opens.
 * @param args.personaId - The persona the session's form names.
 * @param args.defaultNamespace - The namespace of a turn whose own is `''` (`learning.namespace` on `gmi()`), as the
 *   opened session reads it, so the form before the open and after it is one. Default `''`.
 * @param args.mode - A turn's mode before the session opens. Default: `on`, with the process switches applied.
 */
export function deferLearnerSession(args: {
  open(namespace: string): Promise<ILearnerSession>;
  traits: HexacoTraitValues;
  sessionId?: string;
  personaId?: string;
  defaultNamespace?: string;
  mode?: () => LearningMode;
}): ILearnerSession {
  let opening: Promise<ILearnerSession> | undefined;
  let opened: ILearnerSession | undefined;
  /** The namespace of the session's first turn: every open is made under it. */
  let firstNamespace: string | undefined;
  /** The user of the session's first turn that is not a tool continuation. */
  let firstUser: { id: string | null } | undefined;
  /** The loss of the learner the first turn the open failed for, of another user or namespace, carried. */
  let lost: 'other_user' | 'other_namespace' | undefined;
  /** Whether the opened session took `lost` itself. */
  let adopted = false;
  const modeNow = args.mode ?? ((): LearningMode => resolveTurnMode('on').mode);
  const { sessionId, personaId } = args;

  /** Why a turn has no learner by the session's rule, read against the first turn as the opened session reads it. */
  const ruleOf = (turn: { userId: string | null; namespace?: string; continuation?: boolean }): 'other_user' | 'other_namespace' | undefined => {
    const namespace = turn.namespace ?? '';
    if (firstNamespace === undefined) firstNamespace = namespace;
    if (!turn.continuation) {
      if (!firstUser) firstUser = { id: turn.userId };
      else if (turn.userId !== firstUser.id) return 'other_user';
    }
    return namespace !== firstNamespace ? 'other_namespace' : undefined;
  };

  /** The session's own form with no learner, under the turn's namespace, else the agent's. */
  const sessionForm = (turnNamespace: string | undefined, mode: LearningMode): TurnScopes | undefined => {
    if (sessionId === undefined || personaId === undefined) return undefined;
    const namespace = (turnNamespace ?? '') || (args.defaultNamespace ?? '');
    const { userScopeId, personaScopeId } = sessionScopeIds(sessionId, namespace, personaId);
    return { learner: 'none', mode, userScopeId, personaScopeId, namespace };
  };

  const sessionFor = (): Promise<ILearnerSession> => {
    if (opened) return Promise.resolve(opened);
    if (opening) return opening;
    const attempt = Promise.resolve()
      .then(() => args.open(firstNamespace ?? ''))
      .then((inner) => {
        // The first loss a failed open carried goes to the session as it opens, whichever call opens it (a turn, a
        // write), so every turn and write after it reads it.
        const adopt = (inner as { adoptLatch?: unknown }).adoptLatch;
        if (lost && typeof adopt === 'function') {
          adopt.call(inner, lost);
          adopted = true;
        } else if (!lost && firstUser && typeof inner.scopesFor === 'function') {
          // The first user the deferred session saw is read by the session against its own learner, as it would have
          // read that turn: a turn of another user before the open (one after a tool continuation, which names no
          // user) ends the session's learner from the next turn on. A read that throws leaves it to the turns.
          try {
            inner.scopesFor({ userId: firstUser.id, namespace: firstNamespace ?? '', workflowSeat: false });
          } catch {
            // The session reads its turns itself.
          }
        }
        opened = inner;
        return inner;
      });
    opening = attempt;
    // A failed open is not kept: the next call opens again, under the same namespace.
    attempt.catch(() => {
      if (opening === attempt) opening = undefined;
    });
    return attempt;
  };

  const session: ILearnerSession = {
    async prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation> {
      const rule = opened ? undefined : ruleOf(input);
      let inner: ILearnerSession;
      try {
        inner = await sessionFor();
      } catch (error) {
        // The open failed for this turn: the session it opens takes the first such loss.
        lost ??= rule;
        throw error;
      }
      const prepared = await inner.prepareTurn(input);
      if (!lost || adopted || !prepared) return prepared;
      // A session that could not take the loss reads the turn by its own rule; the loss is the first and stands over
      // that reading. A reason the session has whatever the turn (no user id, a placeholder user, no agent key, a
      // workflow seat) stays.
      if (prepared.learner === 'bound') {
        // The session never saw the turn that ended its learner: this turn renders the authored traits and files under
        // the session's own form.
        const section = renderPersonalitySection(args.traits);
        const scopes = sessionForm(input.namespace, prepared.mode);
        return {
          systemPrompts: section ? [{ content: section, priority: PERSONALITY_PROMPT_PRIORITY, source: 'learning:personality' }] : [],
          learner: 'none',
          noLearnerReason: lost,
          mode: prepared.mode,
          ...(scopes ? { scopes } : {}),
        };
      }
      if (prepared.noLearnerReason === 'other_user' || prepared.noLearnerReason === 'other_namespace') {
        return { ...prepared, noLearnerReason: lost };
      }
      return prepared;
    },
    async endSession(): Promise<void> {
      const inner = opened ?? (await opening?.catch(() => undefined));
      await inner?.endSession();
    },
    currentTraits: (): HexacoTraitValues => (opened ? opened.currentTraits() : { ...args.traits }),
    isFrozen: (turn?: SelfChangeTurn): boolean =>
      opened?.isFrozen ? opened.isFrozen(turn) : processIsFrozen() || modeNow() === 'frozen',
    async recordSelfChange<T>(input: SessionSelfChange<T>, turn?: SelfChangeTurn): Promise<ProposalResult<T>> {
      const inner = await sessionFor().catch(() => undefined);
      if (!inner?.recordSelfChange) return { status: 'rejected', reason: 'store_unavailable' };
      return inner.recordSelfChange(input, turn);
    },
    async guardMemoryWrite<T>(input: GuardedMemoryWrite<T>, turn?: SelfChangeTurn): Promise<GuardResult<T>> {
      const inner = await sessionFor().catch(() => undefined);
      if (!inner?.guardMemoryWrite) return { status: 'rejected', reason: 'store_unavailable' };
      return inner.guardMemoryWrite(input, turn);
    },
  };
  if (sessionId !== undefined && personaId !== undefined) {
    session.scopesFor = (turn): TurnScopes => {
      // A host's own session that could not take a loss, or that names no scopes, answers with the session's form.
      if (opened && !(lost && !adopted) && opened.scopesFor) return opened.scopesFor(turn);
      // Before the open: the turn's namespace and user are read as the first turn's when it is the first; the turn's
      // own preparation reads it against the first and keeps the loss when its open fails.
      if (!opened) ruleOf(turn);
      return sessionForm(turn.namespace, modeNow())!;
    };
  }
  return session;
}
