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
   *   turn's input, or the GMI is shutting down. An analysis of a turn it does not hold writes nothing more.
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
   * sentiment trends. Scores, counters and the events themselves stay.
   *
   * @param keptTurnIds - The turns whose input is still in the history.
   */
  public async forgetTurnsExcept(keptTurnIds: ReadonlySet<string>): Promise<void> {
    this._eventHistory = this._eventHistory.map((event) => {
      if (keptTurnIds.has(event.turnId) || event.metadata.evidencePreview === undefined) return event;
      const { evidencePreview: _dropped, ...metadata } = event.metadata;
      return { ...event, metadata };
    });

    const history = await this.workingMemory.get<SentimentHistoryState>('gmi_sentiment_history');
    if (!history?.trends?.some((trend) => trend.context && !keptTurnIds.has(trend.turnId))) return;
    history.trends = history.trends.map((trend) => (keptTurnIds.has(trend.turnId) ? trend : { ...trend, context: '' }));
    await this.workingMemory.set('gmi_sentiment_history', history);
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
   * moment the writes begin, before the store has saved it. A store write cannot be cancelled: when the history
   * write lands once the result may not be applied, the analysis takes it back.
   * A failure is logged as one `gmi.sentiment_failed` event with the error's type and code and a trace warning;
   * it never fails the turn.
   *
   * @param turnId - Current turn identifier.
   * @param userInput - The user's input text to analyze.
   * @param mayApply - Whether the turn takes this analysis' result: false once the turn dropped it, ended or
   *   stopped.
   * @param onCommit - Called once the result is in and its writes begin.
   */
  public async analyzeTurnSentiment(
    turnId: string,
    userInput: string,
    mayApply: () => boolean = () => true,
    onCommit: () => void = () => {},
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

    try {
      const sentimentResult = await this.utilityAI.analyzeSentiment(userInput, {
        method: stConfig?.method,
        modelId: stConfig?.modelId || persona.defaultModelId,
        providerId: stConfig?.providerId || persona.defaultProviderId,
        language,
      });
      if (!live()) return;

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
      const frustrationThreshold = stConfig?.frustrationThreshold ?? -0.3;
      const satisfactionThreshold = stConfig?.satisfactionThreshold ?? 0.3;

      if (sentimentResult.score < frustrationThreshold) {
        sentimentHistory.consecutiveFrustration++;
        sentimentHistory.consecutiveConfusion = 0;
        sentimentHistory.consecutiveSatisfaction = 0;
      } else if (sentimentResult.score > satisfactionThreshold) {
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
      if (!live()) return;
      await this.workingMemory.set('gmi_sentiment_history', sentimentHistory);
      if (!live()) {
        // The turn dropped the result, ended, stopped or was forgotten while the store was writing.
        await this.takeBackHistoryWrite(turnId, replaced);
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
    } catch (error: unknown) {
      if (!live()) return;
      const fields = errorFields(error);
      sentimentLog.warn('gmi.sentiment_failed', fields);
      this.addTraceEntry('WARNING', 'Sentiment analysis failed', fields);
    }
  }

  /**
   * Takes back the history write of an analysis whose result may not be applied, for a write the store
   * finished after the turn dropped the result (its post-turn check stopped waiting, or it ended, stopped or was
   * forgotten). While that write is the stored history's latest, the history it replaced is put back, or the key
   * is deleted when there was none; after a later analysis wrote, only this turn's trend is removed. Either way the
   * excerpts of turns the GMI does not hold are cleared, as `forgetTurnsExcept` does: the write may carry
   * excerpts a forgotten-turn scrub cleared while it was in flight.
   *
   * @param turnId - The turn whose analysis wrote.
   * @param replaced - The history the write replaced, as the analysis read it.
   */
  private async takeBackHistoryWrite(turnId: string, replaced: SentimentHistoryState | undefined): Promise<void> {
    const stored = await this.workingMemory.get<SentimentHistoryState>('gmi_sentiment_history');
    if (!stored) return;
    const restored = stored.lastAnalyzedTurnId === turnId
      ? replaced
      : { ...stored, trends: stored.trends.filter((trend) => trend.turnId !== turnId) };
    if (!restored) {
      await this.workingMemory.delete('gmi_sentiment_history');
      return;
    }
    await this.workingMemory.set('gmi_sentiment_history', {
      ...restored,
      trends: restored.trends.map((trend) => (
        (this.holdsTurn(trend.turnId) || !trend.context) ? trend : { ...trend, context: '' }
      )),
    });
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
