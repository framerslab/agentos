/**
 * @fileoverview Tracks user sentiment across conversation turns, detects emotional
 * patterns, and emits GMI events that trigger event-based metaprompts.
 *
 * Owns the pending event set and event history buffer. Depends on IUtilityAI for
 * sentiment analysis, IWorkingMemory for persistence, and the persona's
 * sentimentTracking config for thresholds and method selection.
 *
 * Extracted from GMI.ts to isolate sentiment/event concerns from the core
 * cognitive engine while preserving full feature parity.
 *
 * @module cognitive_substrate/SentimentTracker
 */

import { IUtilityAI } from '../nlp/ai_utilities/IUtilityAI';
import { IWorkingMemory } from './memory/IWorkingMemory';
import { ChatMessage } from '../../core/llm/providers/IProvider';
import { moduleLogger } from '../../core/logging/loggerFactory';
import { errorFields } from '../../core/logging/events';
import {
  GMIEventType,
  GMIEvent,
  SentimentHistoryState,
  createGMIEvent,
} from './GMIEvent.js';
import type {
  ReasoningTraceEntry,
  ReasoningEntryType,
  UserContext,
} from './IGMI';
import type { IPersonaDefinition } from './personas/IPersonaDefinition';

const sentimentLog = moduleLogger('SentimentTracker', 'library');

/**
 * What event detection reads, copied when a turn's analysis starts: the persona's sentiment settings, the last ten
 * reasoning-trace entries and the last five history messages. Work the turn does while the analysis runs does not
 * change the events it raises.
 */
type SentimentSnapshot = {
  config: IPersonaDefinition['sentimentTracking'];
  trace: readonly ReasoningTraceEntry[];
  history: readonly ChatMessage[];
};

/**
 * A sentiment history the tracker wrote and stands by, from the moment the write starts: an applied analysis', a
 * scrub's or a take-back's (`undefined` when the take-back deleted the key), with the analysis that wrote it.
 */
type StandingHistory = { history: SentimentHistoryState | undefined; writer?: object };

/**
 * How many turns whose history writes were taken back the tracker remembers. A turn's trend can come back only through
 * a write that read the store between the dropped write landing and its take-back landing, so a few are enough.
 */
const DROPPED_TURNS_KEPT = 64;

/**
 * The consecutive counter a sentiment score moves: frustration below the frustration threshold, satisfaction above
 * the satisfaction threshold, confusion between them.
 *
 * @param score - The turn's sentiment score.
 * @param config - The persona's sentiment settings.
 */
function counterMovedBy(
  score: number,
  config: IPersonaDefinition['sentimentTracking'],
): 'frustration' | 'satisfaction' | 'confusion' {
  if (score < (config?.frustrationThreshold ?? -0.3)) return 'frustration';
  if (score > (config?.satisfactionThreshold ?? 0.3)) return 'satisfaction';
  return 'confusion';
}

/**
 * Tracks user sentiment, detects emotional patterns, and emits GMI events.
 *
 * The tracker maintains two data structures:
 * - `pendingGMIEvents`: a set of event types waiting to be consumed by metaprompt
 *   trigger checking. Events are added here when detected and removed when consumed.
 * - `eventHistory`: a circular buffer (max 20) of full event objects for debugging.
 *
 * All configuration (thresholds, methods, models) is sourced from the persona's
 * `sentimentTracking` config block, with sensible defaults when omitted.
 */
export class SentimentTracker {
  /** Event types awaiting consumption by metaprompt trigger logic. */
  private _pendingGMIEvents: Set<GMIEventType> = new Set();

  /** Circular buffer of recent events for debugging/introspection. */
  private _eventHistory: GMIEvent[] = [];

  /**
   * The sentiment history the store should hold by this tracker's writes: what a write that lands after its turn
   * dropped the result is taken back to.
   */
  private standing?: StandingHistory;

  /**
   * The forgets that have ended ({@link SentimentTracker.forgetTurnsExcept}). A history write that read the store
   * before one ended can land after its scrub, so the scrub runs again once that write lands.
   */
  private forgets = 0;

  /**
   * The turns whose history writes were taken back, oldest first. Every later history write leaves their trends out:
   * one that read the store while it held a dropped write would otherwise write that turn's trend and excerpt back.
   */
  private readonly droppedTurns = new Set<string>();

  /**
   * Creates a new SentimentTracker.
   *
   * @param utilityAI - AI utility service for sentiment analysis.
   * @param workingMemory - Working memory for persisting sentiment history.
   * @param getPersona - Callback returning the active persona (for config access).
   * @param getConversationHistory - Callback returning the current conversation history.
   * @param getReasoningTraceEntries - Callback returning recent reasoning trace entries.
   * @param getUserContext - Callback returning the current user context.
   * @param setUserContext - Callback to persist updated user context.
   * @param addTraceEntry - Callback to add entries to the GMI's reasoning trace.
   * @param _getGmiId - Kept in its position for existing callers; not read.
   * @param holdsTurn - Whether the GMI holds a turn: false once a replaced or cleared history dropped the
   *   turn's input. An analysis of a turn it does not hold writes nothing more, and a scrub that runs again after
   *   a late write clears the excerpts of the turns it does not hold.
   */
  constructor(
    private readonly utilityAI: IUtilityAI,
    private readonly workingMemory: IWorkingMemory,
    private readonly getPersona: () => IPersonaDefinition,
    private readonly getConversationHistory: () => readonly ChatMessage[],
    private readonly getReasoningTraceEntries: () => readonly ReasoningTraceEntry[],
    private readonly getUserContext: () => UserContext,
    private readonly setUserContext: (ctx: UserContext) => Promise<void>,
    private readonly addTraceEntry: (type: string, message: string, details?: Record<string, any>) => void,
    _getGmiId: () => string,
    private readonly holdsTurn: (turnId: string) => boolean = () => true,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the set of pending event types that have not yet been consumed.
   */
  public get pendingEvents(): Set<GMIEventType> {
    return this._pendingGMIEvents;
  }

  /**
   * Returns the current pending events set and clears it.
   *
   * Used by metaprompt trigger logic to atomically read and consume events.
   *
   * @returns The set of event types that were pending.
   */
  public consumePendingEvents(): Set<GMIEventType> {
    const consumed = new Set(this._pendingGMIEvents);
    this._pendingGMIEvents.clear();
    return consumed;
  }

  /**
   * Returns a readonly view of the event history buffer.
   */
  public get events(): readonly GMIEvent[] {
    return this._eventHistory;
  }

  /**
   * Drops the input excerpts kept for turns the conversation history no longer
   * holds: the `evidencePreview` of their events and the `context` of their
   * sentiment trends. Scores, counters and the events themselves stay. A sentiment history write that read the
   * store before this scrub ended is scrubbed again once it lands.
   *
   * @param keptTurnIds - The turns whose input is still in the history.
   */
  public async forgetTurnsExcept(keptTurnIds: ReadonlySet<string>): Promise<void> {
    this._eventHistory = this._eventHistory.map((event) => {
      if (keptTurnIds.has(event.turnId) || event.metadata.evidencePreview === undefined) return event;
      const { evidencePreview: _dropped, ...metadata } = event.metadata;
      return { ...event, metadata };
    });

    try {
      await this.clearStoredExcerpts((turnId) => keptTurnIds.has(turnId));
    } finally {
      this.forgets += 1;
    }
  }

  /**
   * Analyzes the sentiment of user input and updates persistent sentiment history.
   *
   * This method:
   * 1. Runs sentiment analysis via IUtilityAI (method configurable per persona).
   * 2. Updates the user context's `currentSentiment` field.
   * 3. Appends to the sentiment trend history (sliding window).
   * 4. Updates consecutive frustration/confusion/satisfaction counters.
   * 5. Triggers event detection based on detected patterns.
   *
   * Event detection reads the persona's settings, the reasoning trace and the history as they were when the
   * analysis started. After each wait the analysis checks that its result may be applied (`mayApply`, and the
   * GMI holding the turn) and stops writing when it may not. `currentSentiment` is set on the user context the
   * moment the writes begin, before the store has saved it. A store write cannot be cancelled: when the user
   * context write lands once the result may not be applied, the GMI's current context is saved over it; when the
   * history write lands then, the analysis takes it back, and every later history write leaves that turn's trend
   * out. A forget that ended while the history was read or written has its scrub run again once the write lands,
   * and every history write clears the excerpts of the turns the GMI does not hold.
   * A failure is logged as one `gmi.sentiment_failed` event with the error's type and code and a trace warning;
   * it never fails the turn. A take-back that fails is logged as one `gmi.sentiment_take_back_failed` event, and so
   * is a scrub run again after a forget that fails once a newer forget dropped the turn.
   *
   * @param turnId - Current turn identifier.
   * @param userInput - The user's input text to analyze.
   * @param mayApply - Whether the turn takes this analysis' result: false once the turn dropped it, ended or
   *   stopped.
   * @param onCommit - Called once the result is in and its writes begin.
   * @param onApplied - Called once the result is applied: the history is written and the events are raised. What
   *   runs after it is the scrub run again after a forget.
   */
  public async analyzeTurnSentiment(
    turnId: string,
    userInput: string,
    mayApply: () => boolean = () => true,
    onCommit: () => void = () => {},
    onApplied: () => void = () => {},
  ): Promise<void> {
    if (!userInput || typeof userInput !== 'string') return;
    const live = () => mayApply() && this.holdsTurn(turnId);
    const persona = this.getPersona();
    const stConfig = persona.sentimentTracking ? { ...persona.sentimentTracking } : undefined;
    // The user's language, else the persona's; with neither, the utility class scores in its own default.
    const language = (this.getUserContext().language as string) || persona.defaultLanguage || undefined;
    const snapshot: SentimentSnapshot = {
      config: stConfig,
      trace: this.getReasoningTraceEntries().slice(-10).map((entry) => ({ ...entry })),
      history: this.getConversationHistory().slice(-5).map((message) => ({
        ...message,
        content: Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : message.content,
      })),
    };
    // Set while the scrub runs again after a forget: a failure there is logged even once the turn is forgotten.
    let scrubbingAgain = false;

    try {
      const sentimentResult = await this.utilityAI.analyzeSentiment(userInput, {
        method: stConfig?.method,
        modelId: stConfig?.modelId || persona.defaultModelId,
        providerId: stConfig?.providerId || persona.defaultProviderId,
        language,
      });
      if (!live()) return;

      // The forgets ended before the read: one that ends later is run again once this analysis' write lands.
      const forgetsAtRead = this.forgets;
      // Get or initialize sentiment history
      let sentimentHistory = await this.workingMemory.get<SentimentHistoryState>(
        'gmi_sentiment_history',
      );
      if (!live()) return;
      // Work on a copy: a discarded result never mutates the stored history by alias.
      if (sentimentHistory) sentimentHistory = {
        ...sentimentHistory,
        trends: [...sentimentHistory.trends],
      };
      // The history this analysis replaces, put back if its write lands once the result may not be applied.
      const replaced = sentimentHistory ? { ...sentimentHistory, trends: [...sentimentHistory.trends] } : undefined;

      if (!sentimentHistory) {
        sentimentHistory = {
          trends: [],
          consecutiveFrustration: 0,
          consecutiveConfusion: 0,
          consecutiveSatisfaction: 0,
        };
      }

      // Add to sentiment trends
      const trend = {
        turnId,
        timestamp: new Date(),
        score: sentimentResult.score,
        polarity: sentimentResult.polarity,
        intensity: sentimentResult.intensity || 0,
        context: userInput.substring(0, 100),
      };

      sentimentHistory.trends.push(trend);

      // Keep only last N trends (configurable sliding window)
      const historyWindow = stConfig?.historyWindow || 10;
      if (sentimentHistory.trends.length > historyWindow) {
        sentimentHistory.trends.shift();
      }

      // Update consecutive counters based on configurable thresholds
      const counter = counterMovedBy(sentimentResult.score, stConfig);

      if (counter === 'frustration') {
        sentimentHistory.consecutiveFrustration++;
        sentimentHistory.consecutiveConfusion = 0;
        sentimentHistory.consecutiveSatisfaction = 0;
      } else if (counter === 'satisfaction') {
        sentimentHistory.consecutiveSatisfaction++;
        sentimentHistory.consecutiveFrustration = 0;
        sentimentHistory.consecutiveConfusion = 0;
      } else {
        sentimentHistory.consecutiveConfusion++;
        sentimentHistory.consecutiveFrustration = 0;
        sentimentHistory.consecutiveSatisfaction = 0;
      }

      sentimentHistory.lastAnalyzedTurnId = turnId;

      if (!live()) return;
      // The writes begin here. The GMI's post-turn check finishes a committed analysis instead of dropping it halfway;
      // a forgotten turn, an abort or a shutdown stops it at the checks below.
      onCommit();
      await this.setUserContext({ ...this.getUserContext(), currentSentiment: sentimentResult.polarity });
      if (!live()) {
        // The turn dropped the result while the store was writing, and a later turn may have saved a newer context
        // before this write landed: the GMI's current context is saved over it.
        await this.afterDroppedWrite(() => this.setUserContext(this.getUserContext()));
        return;
      }
      // The history read may hold a dropped turn's write that its take-back has not replaced yet: its trend stays out,
      // and its counters with it. A turn analysed again keeps its new trend. It may also hold the excerpt of a turn a
      // forget dropped before a scrub cleared it from the store: that excerpt stays out too.
      this.droppedTurns.delete(turnId);
      sentimentHistory = this.withoutDroppedTurns(this.withHeldExcerpts(sentimentHistory), stConfig);
      const writer = {};
      const before = this.standing;
      this.standing = { history: sentimentHistory, writer };
      try {
        await this.workingMemory.set('gmi_sentiment_history', sentimentHistory);
      } catch (error: unknown) {
        // The store never held this history, so it is no base to put the store back to.
        if (this.standing?.writer === writer) this.standing = before;
        throw error;
      }
      if (!live()) {
        // The turn dropped the result, ended, failed, stopped or was forgotten while the store was writing.
        await this.afterDroppedWrite(
          () => this.takeBackHistoryWrite(turnId, writer, before, replaced),
        );
        return;
      }

      this.addTraceEntry(
        'DEBUG',
        'Turn sentiment analyzed',
        {
          sentiment: {
            score: sentimentResult.score,
            polarity: sentimentResult.polarity,
            intensity: sentimentResult.intensity,
          },
          consecutiveCounters: {
            frustration: sentimentHistory.consecutiveFrustration,
            confusion: sentimentHistory.consecutiveConfusion,
            satisfaction: sentimentHistory.consecutiveSatisfaction,
          },
        },
      );

      // Detect and emit events based on sentiment patterns
      await this.detectAndEmitEvents(turnId, userInput, sentimentResult, sentimentHistory, snapshot);
      onApplied();
      // A forget that ended while the history was read or written may have scrubbed the store before this write
      // landed with the excerpts it cleared.
      scrubbingAgain = true;
      await this.clearExcerptsAfterForgets(forgetsAtRead);
    } catch (error: unknown) {
      if (!live()) {
        // A newer forget dropped the turn while its scrub ran again: that forget's own scrub clears the store, and
        // the failure is one line with the error's type and code.
        if (scrubbingAgain) sentimentLog.warn('gmi.sentiment_take_back_failed', errorFields(error));
        return;
      }
      const fields = errorFields(error);
      sentimentLog.warn('gmi.sentiment_failed', fields);
      this.addTraceEntry('WARNING', 'Sentiment analysis failed', fields);
    }
  }

  /**
   * Runs the clean-up of a write that landed once its result could not be applied. Its turn may have ended, so a
   * failure writes one `gmi.sentiment_take_back_failed` event with the error's type and code, and nothing else.
   *
   * @param cleanUp - The writes that put the store back.
   */
  private async afterDroppedWrite(cleanUp: () => Promise<void>): Promise<void> {
    try {
      await cleanUp();
    } catch (error: unknown) {
      sentimentLog.warn('gmi.sentiment_take_back_failed', errorFields(error));
    }
  }

  /**
   * Takes back the history write of an analysis whose result may not be applied, once the store has finished it:
   * the turn dropped the result (its post-turn check stopped waiting, or it ended, failed, stopped or was
   * forgotten) while the write was in flight, and the write may have landed over a newer one. The stored history
   * becomes the one the tracker stands by: a later write's, else the one it stood by before this write, else the one
   * the analysis read; with none, the key is deleted. This turn's trend, and those of the other turns taken back, are
   * left out of it and of every later history write. The excerpts of the turns the GMI does not hold are cleared,
   * before the write and again after it while forgets end meanwhile: the history put back may be one a forget never
   * scrubbed.
   *
   * @param turnId - The turn whose analysis wrote.
   * @param writer - The analysis' mark on {@link SentimentTracker.standing}.
   * @param before - What the tracker stood by when the write started.
   * @param read - The history the analysis read before it wrote.
   */
  private async takeBackHistoryWrite(
    turnId: string,
    writer: object,
    before: StandingHistory | undefined,
    read: SentimentHistoryState | undefined,
  ): Promise<void> {
    this.droppedTurns.add(turnId);
    if (this.droppedTurns.size > DROPPED_TURNS_KEPT) {
      const oldest = this.droppedTurns.values().next();
      if (!oldest.done) this.droppedTurns.delete(oldest.value);
    }
    const latest = this.standing;
    const base = latest && latest.writer !== writer ? latest.history : before ? before.history : read;
    const forgets = this.forgets;
    const restored = base && this.withoutDroppedTurns(this.withHeldExcerpts(base));
    this.standing = { history: restored };
    if (restored) await this.workingMemory.set('gmi_sentiment_history', restored);
    else await this.workingMemory.delete('gmi_sentiment_history');
    await this.clearExcerptsAfterForgets(forgets);
  }

  /**
   * Runs the forgotten-turn scrub again, with the turns the GMI holds now, while forgets end after `seen`: a write
   * that read the store before a forget ended can land after its scrub with the excerpts it cleared.
   *
   * @param seen - The forgets ended when the write's history was read.
   */
  private async clearExcerptsAfterForgets(seen: number): Promise<void> {
    let ended = seen;
    while (this.forgets !== ended) {
      ended = this.forgets;
      await this.clearStoredExcerpts((turnId) => this.holdsTurn(turnId));
    }
  }

  /**
   * Clears the `context` of each stored sentiment trend whose turn `keeps` does not keep, and leaves out the trends
   * of turns taken back; writes only when one has an excerpt to clear or is taken back.
   *
   * @param keeps - Whether a turn keeps its excerpt.
   */
  private async clearStoredExcerpts(keeps: (turnId: string) => boolean): Promise<void> {
    const history = await this.workingMemory.get<SentimentHistoryState>('gmi_sentiment_history');
    if (!history?.trends?.some((trend) => this.droppedTurns.has(trend.turnId) || (trend.context && !keeps(trend.turnId)))) {
      return;
    }
    const scrubbed = this.withoutDroppedTurns({
      ...history,
      trends: history.trends.map((trend) => (keeps(trend.turnId) ? trend : { ...trend, context: '' })),
    });
    this.standing = { history: scrubbed };
    await this.workingMemory.set('gmi_sentiment_history', scrubbed);
  }

  /**
   * `history` with the `context` of each trend whose turn the GMI does not hold cleared.
   *
   * @param history - The history a write is about to hold.
   */
  private withHeldExcerpts(history: SentimentHistoryState): SentimentHistoryState {
    if (!history.trends.some((trend) => trend.context && !this.holdsTurn(trend.turnId))) return history;
    return {
      ...history,
      trends: history.trends.map((trend) => (!trend.context || this.holdsTurn(trend.turnId) ? trend : { ...trend, context: '' })),
    };
  }

  /**
   * `history` without the trends of the turns whose history writes were taken back. When it leaves one out, the
   * consecutive counters and `lastAnalyzedTurnId` are counted again from the trends that stay, so a taken-back turn
   * moves no counter. That count reaches back no further than the trends the history window keeps.
   *
   * @param history - The history a write is about to hold.
   * @param config - The sentiment settings whose thresholds count the trends.
   */
  private withoutDroppedTurns(
    history: SentimentHistoryState,
    config: IPersonaDefinition['sentimentTracking'] = this.getPersona().sentimentTracking,
  ): SentimentHistoryState {
    const trends = history.trends.filter((trend) => !this.droppedTurns.has(trend.turnId));
    if (trends.length === history.trends.length) return history;
    const { lastAnalyzedTurnId: _replaced, ...kept } = history;
    const last = trends[trends.length - 1];
    const counter = last && counterMovedBy(last.score, config);
    let run = 0;
    while (counter && run < trends.length && counterMovedBy(trends[trends.length - 1 - run].score, config) === counter) {
      run += 1;
    }
    return {
      ...kept,
      trends,
      consecutiveFrustration: counter === 'frustration' ? run : 0,
      consecutiveConfusion: counter === 'confusion' ? run : 0,
      consecutiveSatisfaction: counter === 'satisfaction' ? run : 0,
      ...(last ? { lastAnalyzedTurnId: last.turnId } : {}),
    };
  }

  /**
   * Detects emotional patterns from sentiment analysis and emits appropriate
   * GMI events.
   *
   * Checks for:
   * - **Frustration**: negative sentiment with high intensity or consecutive negative turns.
   * - **Confusion**: confusion keywords in input or neutral sentiment with negative tokens.
   * - **Satisfaction**: positive sentiment with high intensity or consecutive positive turns.
   * - **Error threshold**: multiple recent errors in the reasoning trace.
   * - **Low engagement**: consecutive neutral sentiment with short user messages.
   *
   * @param turnId - Current turn identifier.
   * @param userInput - The user's input text.
   * @param sentimentResult - The sentiment analysis result.
   * @param sentimentHistory - The historical sentiment data.
   * @param snapshot - The settings, trace and history copied when the analysis started; the live ones without it.
   */
  public async detectAndEmitEvents(
    turnId: string,
    userInput: string,
    sentimentResult: { score: number; polarity: 'positive' | 'negative' | 'neutral'; intensity?: number; negativeTokens?: any[] },
    sentimentHistory: SentimentHistoryState,
    snapshot?: SentimentSnapshot,
  ): Promise<void> {
    const stConfig = snapshot ? snapshot.config : this.getPersona().sentimentTracking;
    const frustThreshold = stConfig?.frustrationThreshold ?? -0.3;
    const satisThreshold = stConfig?.satisfactionThreshold ?? 0.3;
    const consecutiveRequired = stConfig?.consecutiveTurnsForTrigger ?? 2;

    // Frustration detection
    if (
      (sentimentResult.score < frustThreshold && (sentimentResult.intensity || 0) > 0.6) ||
      sentimentHistory.consecutiveFrustration >= consecutiveRequired
    ) {
      this.emitEvent(
        createGMIEvent(
          GMIEventType.USER_FRUSTRATED,
          turnId,
          sentimentHistory.consecutiveFrustration >= 2 ? 'high' : 'medium',
          {
            sentimentScore: sentimentResult.score,
            sentimentPolarity: sentimentResult.polarity,
            sentimentIntensity: sentimentResult.intensity,
            consecutiveTurns: sentimentHistory.consecutiveFrustration,
            triggeredBy: 'sentiment',
          },
        ),
      );
    }

    // Confusion detection (keyword-based + sentiment)
    const confusionKeywords = [
      'confused',
      "don't understand",
      "dont understand",
      'unclear',
      'what do you mean',
      'explain',
      'clarify',
      'huh',
      '??',
      "doesn't make sense",
      "doesnt make sense",
      'not sure',
    ];

    const lowerInput = userInput.toLowerCase();
    const hasConfusionKeyword = confusionKeywords.some((keyword) =>
      lowerInput.includes(keyword),
    );
    const triggerKeywords = hasConfusionKeyword
      ? confusionKeywords.filter((keyword) => lowerInput.includes(keyword))
      : [];

    if (
      hasConfusionKeyword ||
      (sentimentResult.polarity === 'neutral' &&
        sentimentResult.negativeTokens &&
        sentimentResult.negativeTokens.length > 2)
    ) {
      this.emitEvent(
        createGMIEvent(
          GMIEventType.USER_CONFUSED,
          turnId,
          sentimentHistory.consecutiveConfusion >= 2 ? 'high' : 'medium',
          {
            triggeredBy: hasConfusionKeyword ? 'keyword' : 'sentiment',
            consecutiveTurns: sentimentHistory.consecutiveConfusion,
            evidencePreview: userInput.substring(0, 100),
            triggerKeywords: hasConfusionKeyword ? triggerKeywords : undefined,
          },
        ),
      );
    }

    // Satisfaction detection
    if (
      (sentimentResult.score > satisThreshold && (sentimentResult.intensity || 0) > 0.5) ||
      sentimentHistory.consecutiveSatisfaction >= (consecutiveRequired + 1)
    ) {
      this.emitEvent(
        createGMIEvent(
          GMIEventType.USER_SATISFIED,
          turnId,
          'low',
          {
            sentimentScore: sentimentResult.score,
            sentimentPolarity: sentimentResult.polarity,
            sentimentIntensity: sentimentResult.intensity,
            consecutiveTurns: sentimentHistory.consecutiveSatisfaction,
            triggeredBy: 'sentiment',
          },
        ),
      );
    }

    // Error threshold detection (check reasoning trace for recent errors)
    const traceEntries = snapshot?.trace ?? this.getReasoningTraceEntries();
    const recentErrors = traceEntries
      .slice(-10)
      .filter((entry) => entry.type === ('ERROR' as ReasoningEntryType));

    if (recentErrors.length >= 2) {
      this.emitEvent(
        createGMIEvent(
          GMIEventType.ERROR_THRESHOLD_EXCEEDED,
          turnId,
          'high',
          {
            triggeredBy: 'error',
            errorCount: recentErrors.length,
            consecutiveTurns: recentErrors.length,
          },
        ),
      );
    }

    // Low engagement detection (consecutive neutral with short responses)
    const conversationHistory = snapshot?.history ?? this.getConversationHistory();
    const recentUserMessages = conversationHistory
      .slice(-5)
      .filter((msg) => msg.role === 'user');

    const avgLength = recentUserMessages.length > 0
      ? recentUserMessages.reduce(
          (sum, msg) => sum + String(msg.content).length,
          0,
        ) / recentUserMessages.length
      : 0;

    if (sentimentHistory.consecutiveConfusion >= 4 && avgLength < 50) {
      this.emitEvent(
        createGMIEvent(
          GMIEventType.LOW_ENGAGEMENT,
          turnId,
          'medium',
          {
            triggeredBy: 'pattern',
            consecutiveTurns: sentimentHistory.consecutiveConfusion,
            evidencePreview: `Avg response length: ${avgLength.toFixed(0)} chars`,
          },
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Emits a GMI event: adds its type to pending events and appends the full
   * event to the circular history buffer.
   *
   * @param event - The event to emit.
   */
  private emitEvent(event: GMIEvent): void {
    this._pendingGMIEvents.add(event.eventType);

    this._eventHistory.push(event);
    if (this._eventHistory.length > 20) {
      this._eventHistory.shift();
    }

    this.addTraceEntry(
      'DEBUG',
      `GMI Event Emitted: ${event.eventType}`,
      {
        event: {
          eventType: event.eventType,
          turnId: event.turnId,
          severity: event.severity,
          metadata: event.metadata,
        },
      },
    );
  }
}
