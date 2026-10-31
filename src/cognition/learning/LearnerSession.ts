/**
 * @module learning/LearnerSession
 *
 * One session's view of the learning layer. It renders the personality section from the persona's authored traits
 * (with a workflow role overlay's patch, for that session only) and says, turn by turn, whether the turn has a
 * learner. A session belongs to the user of its first turn and to the namespace the host opened it under: a turn of
 * another user or another namespace, and every turn after it, has no learner.
 */
import type { HexacoTraitValues } from '../substrate/personas/hexaco.js';
import {
  applyTraitOverlay,
  droppedTraitPatchWarning,
  PERSONALITY_PROMPT_PRIORITY,
  renderPersonalitySection,
} from '../substrate/personas/personalityPrompt.js';
import type {
  ILearnerSession,
  LearnerContext,
  LearnerKey,
  LearningMode,
  NoLearnerReason,
  TurnInputForLearning,
  TurnPreparation,
} from './types.js';

/** What a learner session reads from the layer that made it. */
export interface LearnerSessionHost {
  /** The mode a turn runs in: the configured mode with the process switches applied. */
  turnMode(): LearningMode;
  /** Counts one prepared turn; `reason` says why it has no learner, when it has none. */
  countTurn(reason: NoLearnerReason | undefined): void;
}

/**
 * Who a session belongs to: its learner and the namespace the host opened it under (before the layer fills
 * `learning.namespace` into the key), or why it has no learner.
 */
export type SessionBinding = { key: LearnerKey; openedUnder: string } | { reason: NoLearnerReason };

export class LearnerSession implements ILearnerSession {
  private readonly traits: HexacoTraitValues;
  private readonly section: string | null;
  /** Set by the first turn of another user or namespace; no turn after it has a learner. */
  private lostLearner: NoLearnerReason | undefined;

  /**
   * @param host - The layer.
   * @param binding - The learner and the namespace the session was opened under, or why it has none.
   * @param context - The session: its persona's authored traits and a role overlay's patch.
   */
  constructor(
    private readonly host: LearnerSessionHost,
    private readonly binding: SessionBinding,
    context: LearnerContext,
  ) {
    const { traits, dropped } = applyTraitOverlay(context.authoredTraits, context.overlayTraits);
    this.traits = traits;
    this.section = renderPersonalitySection(traits);
    if (dropped.length > 0) {
      console.warn(`[agentos] learning: ${droppedTraitPatchWarning(context.personaId, dropped)}`);
    }
  }

  async prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation> {
    const reason = this.noLearnerReasonFor(input);
    this.host.countTurn(reason);
    return {
      systemPrompts: this.section
        ? [{ content: this.section, priority: PERSONALITY_PROMPT_PRIORITY, source: 'learning:personality' }]
        : [],
      learner: reason ? 'none' : 'bound',
      ...(reason ? { noLearnerReason: reason } : {}),
      mode: this.host.turnMode(),
    };
  }

  /**
   * Why this turn has no learner, or `undefined` when it has one. Every turn is read against the session's user and
   * namespace first, a workflow turn included, so a turn of another user or namespace ends the session's learner
   * whatever else it is. A tool continuation carries the GMI's own user (the GMI builds its input), so only its
   * namespace is read: a continuation under another organization (a resume whose host passed one) ends it too.
   */
  private noLearnerReasonFor(input: TurnInputForLearning): NoLearnerReason | undefined {
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

  /**
   * Takes the loss of the learner that a deferred session saw on a turn it could not open for
   * ({@link deferLearnerSession}): no turn of this session has a learner from now on, as if the session had been open
   * at that turn. A session with no learner keeps its own reason.
   *
   * @param reason - Why the turn the deferred session saw has no learner.
   */
  adoptLatch(reason: 'other_user' | 'other_namespace'): void {
    if ('reason' in this.binding || this.lostLearner) return;
    this.lostLearner = reason;
  }

  /** Nothing to flush: the session holds no state that outlives it. */
  async endSession(): Promise<void> {}

  currentTraits(): HexacoTraitValues {
    return { ...this.traits };
  }
}

/**
 * A learner session whose learner is named at its first turn: the full runtime's GMIs built where the turn's
 * organization is not known yet (a GMI built again for a tool-result resume), and a session whose open failed. The
 * session is opened under the namespace its first turn carries, on every attempt, and every later turn is read against
 * it. A turn the open failed for is read against the first one as the opened session reads it (a tool continuation
 * carries the GMI's own user, so only its namespace is read): the first such turn of another user or another namespace
 * is remembered, and once the session opens no turn has a learner. A turn the opened session prepares, one that waited
 * on the same open included, is read by the session itself, in the order the turns came. A session that cannot take
 * the loss ({@link LearnerSession.adoptLatch}, a host's own that has no `adoptLatch`) has its later turns answered with
 * no learner here.
 *
 * @param args.open - Opens the session for the first turn's namespace. A failed open is tried again on the next turn,
 *   under the same namespace.
 * @param args.traits - What `currentTraits()` answers before the session is open.
 */
export function deferLearnerSession(args: {
  open(namespace: string): Promise<ILearnerSession>;
  traits: HexacoTraitValues;
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

  /** Why a turn has no learner by the session's rule, read against the first turn as the opened session reads it. */
  const ruleOf = (input: TurnInputForLearning): 'other_user' | 'other_namespace' | undefined => {
    const namespace = input.namespace ?? '';
    if (firstNamespace === undefined) firstNamespace = namespace;
    if (!input.continuation) {
      if (!firstUser) firstUser = { id: input.userId };
      else if (input.userId !== firstUser.id) return 'other_user';
    }
    return namespace !== firstNamespace ? 'other_namespace' : undefined;
  };

  const sessionFor = (): Promise<ILearnerSession> => {
    if (opened) return Promise.resolve(opened);
    if (opening) return opening;
    const attempt = Promise.resolve()
      .then(() => args.open(firstNamespace ?? ''))
      .then((inner) => {
        opened = inner;
        return inner;
      });
    opening = attempt;
    // A failed open is not kept: the next turn opens again, under the same namespace.
    attempt.catch(() => {
      if (opening === attempt) opening = undefined;
    });
    return attempt;
  };

  return {
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
      // Handed over as the session prepares a turn, so a turn it reads itself keeps its own answer.
      if (lost && !adopted) {
        const adopt = (inner as { adoptLatch?: unknown }).adoptLatch;
        if (typeof adopt === 'function') {
          adopt.call(inner, lost);
          adopted = true;
        }
      }
      const prepared = await inner.prepareTurn(input);
      // A session that could not take the loss answers by its own reading of the session's rule; the loss is the first
      // and stands over it. A reason the session has whatever the turn (no user id, a placeholder user, no agent key, a
      // workflow seat) stays.
      const ruled = prepared?.learner === 'bound' || prepared?.noLearnerReason === 'other_user' || prepared?.noLearnerReason === 'other_namespace';
      if (lost && !adopted && prepared && ruled) {
        return { ...prepared, learner: 'none', noLearnerReason: lost };
      }
      return prepared;
    },
    async endSession(): Promise<void> {
      const inner = opened ?? (await opening?.catch(() => undefined));
      await inner?.endSession();
    },
    currentTraits: (): HexacoTraitValues => (opened ? opened.currentTraits() : { ...args.traits }),
  };
}
