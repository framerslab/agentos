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
   * whatever else it is (D3). A tool continuation carries the GMI's own user (the GMI builds its input), so only its
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

  /** Nothing to flush: the session holds no state that outlives it. */
  async endSession(): Promise<void> {}

  currentTraits(): HexacoTraitValues {
    return { ...this.traits };
  }
}

/**
 * A learner session whose learner is named at its first turn: the full runtime's GMIs built where the turn's
 * organization is not known yet (a GMI built again for a tool-result resume). The session is opened under the
 * namespace its first turn carries, and every later turn is read against it.
 *
 * @param args.open - Opens the session for the first turn's namespace. A failed open is tried again on the next turn.
 * @param args.traits - What `currentTraits()` answers before the session is open.
 */
export function deferLearnerSession(args: {
  open(namespace: string): Promise<ILearnerSession>;
  traits: HexacoTraitValues;
}): ILearnerSession {
  let opening: Promise<ILearnerSession> | undefined;
  let opened: ILearnerSession | undefined;
  const sessionFor = (namespace: string): Promise<ILearnerSession> => {
    if (opening) return opening;
    const attempt = Promise.resolve()
      .then(() => args.open(namespace))
      .then((inner) => {
        opened = inner;
        return inner;
      });
    opening = attempt;
    // A failed open is not kept: the next turn opens again.
    attempt.catch(() => {
      if (opening === attempt) opening = undefined;
    });
    return attempt;
  };
  return {
    async prepareTurn(input: TurnInputForLearning): Promise<TurnPreparation> {
      const inner = await sessionFor(input.namespace ?? '');
      return inner.prepareTurn(input);
    },
    async endSession(): Promise<void> {
      const inner = await opening?.catch(() => undefined);
      await inner?.endSession();
    },
    currentTraits: (): HexacoTraitValues => (opened ? opened.currentTraits() : { ...args.traits }),
  };
}
