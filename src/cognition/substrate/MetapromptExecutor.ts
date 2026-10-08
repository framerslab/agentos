/**
 * @fileoverview Handles metaprompt trigger checking, routing, execution, and
 * state application for the GMI.
 *
 * Supports three trigger types: `turn_interval` (periodic), `event_based`
 * (driven by SentimentTracker events), and `manual` (flags in working memory).
 * Includes pre-built handlers for frustration recovery, confusion clarification,
 * satisfaction reinforcement, error recovery, engagement boost, and trait
 * adjustment, plus a generic handler for custom metaprompts.
 *
 * Extracted from GMI.ts to isolate metaprompt lifecycle concerns from the core
 * cognitive engine while preserving full feature parity.
 *
 * @module cognitive_substrate/MetapromptExecutor
 */

import { ChatMessage, ModelCompletionOptions } from '../../core/llm/providers/IProvider';
import { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import { IUtilityAI, ParseJsonOptions } from '../nlp/ai_utilities/IUtilityAI';
import { IWorkingMemory } from './memory/IWorkingMemory';
import {
  GMIMood,
  GMIPrimeState,
  UserContext,
  TaskContext,
  ReasoningEntryType,
  ReasoningTraceEntry,
} from './IGMI';
import type { IPersonaDefinition, MetaPromptDefinition } from './personas/IPersonaDefinition';
import { GMIEventType, SentimentHistoryState, GMIEvent } from './GMIEvent.js';
import { GMIError, GMIErrorCode, createGMIErrorFromError } from '../../core/utils/errors.js';

/**
 * Configuration for the MetapromptExecutor, providing all required dependencies
 * via callbacks to avoid direct coupling to GMI internals.
 */
export interface MetapromptExecutorConfig {
  /** Working memory for persisting turn counters and reading sentiment history. */
  workingMemory: IWorkingMemory;
  /** LLM provider manager for executing metaprompt LLM calls. */
  llmProviderManager: AIModelProviderManager;
  /** AI utility service for JSON parsing with LLM recovery. */
  utilityAI: IUtilityAI;
  /** Callback returning the active persona definition. */
  getPersona: () => IPersonaDefinition;
  /** Callback to add entries to the GMI's reasoning trace. */
  addTraceEntry: (type: string, message: string, details?: Record<string, any>) => void;
  /** Callback to determine model and provider for an internal LLM call. */
  getModelAndProvider: (
    preferredModel?: string,
    preferredProvider?: string,
  ) => { modelId: string; providerId: string };
  /** Callback invoked when a metaprompt updates the GMI's mood. */
  onMoodUpdate: (mood: GMIMood) => void;
  /** Callback invoked when a metaprompt updates the user context. */
  onUserContextUpdate: (updates: Partial<UserContext>) => void;
  /** Callback invoked when a metaprompt updates the task context. */
  onTaskContextUpdate: (updates: Partial<TaskContext>) => void;
  /** Callback to encode a memory imprint via the cognitive memory bridge. */
  onMemoryImprint: (content: string, tags: string[]) => Promise<void>;
  /** Callback returning the set of pending GMI event types. */
  getPendingEvents: () => Set<GMIEventType>;
  /** Callback returning the event history buffer. */
  getEventHistory: () => readonly GMIEvent[];
  /** Callback returning the current conversation history. */
  getConversationHistory: () => readonly ChatMessage[];
  /** Callback returning recent reasoning trace entries. */
  getReasoningTraceEntries: () => readonly ReasoningTraceEntry[];
  /** Callback returning the current GMI mood. */
  getMood: () => GMIMood;
  /** Callback returning the current user context. */
  getUserContext: () => UserContext;
  /** Callback returning the current task context. */
  getTaskContext: () => TaskContext;
  /**
   * Callback to set the GMI's operational state.
   *
   * @deprecated Metaprompt runs no longer change lifecycle state; the executor never calls this.
   */
  setState: (state: GMIPrimeState) => void;
  /**
   * Callback returning the current GMI operational state.
   *
   * @deprecated The executor no longer reads lifecycle state; it tracks its own work queue.
   */
  getState: () => GMIPrimeState;
  /** Callback returning the GMI instance ID (for logging). */
  getGmiId: () => string;
}

/** Longest time {@link MetapromptExecutor.drain} waits by default, in milliseconds. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

/**
 * Longest a queued unit of metaprompt work may run before the queue moves on
 * without it, in milliseconds. Each metaprompt LLM call also carries it as its
 * request timeout, so a stalled provider call is normally cut off first.
 */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * Working-memory keys that hold the GMI's own state. A metaprompt changes
 * mood, user and task context through its update fields, which the GMI
 * persists under these keys; an imprint that wrote them would bypass that
 * path (and race it after a deadline) or fire a manual trigger.
 */
function isGmiStateKey(key: string): boolean {
  return (
    key === 'currentGmiMood' ||
    key === 'currentUserContext' ||
    key === 'currentTaskContext' ||
    key === 'gmi_sentiment_history' ||
    key.startsWith('manual_trigger_') ||
    key.startsWith('metaprompt_turn_counter_')
  );
}

/**
 * One unit of metaprompt work on the queue (a batch or a self-reflection
 * cycle). `isStale()` turns true when the unit ran past its deadline and the
 * queue moved on without it, or when the executor was closed; its results are
 * then discarded rather than applied.
 */
export interface MetapromptRun {
  isStale(): boolean;
}

/**
 * Handles metaprompt trigger checking, execution, and state application.
 *
 * The metaprompts that fire on one turn are queued as one background batch.
 * Batches and manual self-reflection cycles run one at a time, in the order
 * they were queued, so two of them never race on the mood and context they
 * update, and the turn that triggered a batch does not wait for its LLM calls.
 * Metaprompt work never changes the GMI's lifecycle state; that state belongs
 * to the turn loop.
 *
 * Owns the per-metaprompt turn counters used by `turn_interval` triggers.
 *
 * All GMI state mutations flow back through callbacks so the executor never
 * directly mutates GMI internals.
 */
export class MetapromptExecutor {
  /** Per-metaprompt turn counters for `turn_interval` triggers. */
  private metaPromptTriggerCounters: Map<string, number> = new Map();

  /**
   * Tail of the metaprompt work queue. Every batch and self-reflection cycle
   * chains onto it, so only one runs at a time. It never rejects.
   */
  private queueTail: Promise<void> = Promise.resolve();

  /** Number of batches and self-reflection cycles that are queued or running. */
  private inFlight = 0;

  /** Metaprompt ids already reported as unable to fire, so each is reported once. */
  private readonly invalidTriggerWarnings = new Set<string>();

  /** Set by {@link MetapromptExecutor.close}: no further work starts, and late results are discarded. */
  private closed = false;

  /** User turns counted so far, to tell whether a queued event batch still belongs to the latest turn. */
  private countedTurns = 0;

  /** Deadline for each queued unit of work, in milliseconds (see DEFAULT_RUN_TIMEOUT_MS). */
  public runTimeoutMs: number = DEFAULT_RUN_TIMEOUT_MS;

  /**
   * The last memory imprint write queued for each key. Writes to one key run
   * in the order they were made: a unit that passes its deadline mid-write
   * releases the queue, but a later unit's write to the same key waits for
   * that write, so it is never overwritten by it. Writes to other keys do
   * not wait, so one stalled write cannot hold back the rest.
   */
  private readonly writeTails = new Map<string, Promise<void>>();

  /** Self-reflection interval (turns between reflections). */
  public selfReflectionIntervalTurns: number;

  /** Turns elapsed since the last self-reflection. */
  public turnsSinceLastReflection: number = 0;

  /**
   * Creates a new MetapromptExecutor.
   *
   * @param config - All dependencies and callbacks.
   */
  constructor(private readonly config: MetapromptExecutorConfig) {
    this.selfReflectionIntervalTurns = 5; // Will be overridden by initialize
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Checks all metaprompt triggers and queues any that fire.
   *
   * Iterates through the persona's metaprompt definitions, evaluating each
   * trigger type:
   * - `turn_interval`: counts user turns and fires on every `intervalTurns`-th
   *   one, so an interval of N fires on user turns N, 2N, 3N and so on.
   * - `event_based`: fires if the event type is in the pending events set.
   * - `manual`: fires if a flag was set in working memory.
   *
   * The metaprompts that fire are queued as one background batch and this
   * method returns without waiting for their LLM calls. Batches run one at a
   * time; inside a batch the metaprompts run in parallel via
   * `Promise.allSettled`. Execution errors are logged to the reasoning trace
   * and never reach the turn.
   *
   * @param turnId - The current turn identifier (for tracing).
   * @param options - `countTurn` says whether this turn counts toward
   *   `turn_interval` triggers. Pass `false` for turns that are not user
   *   messages, such as tool continuations and system turns. Defaults to `true`.
   */
  public async checkAndTriggerMetaprompts(
    turnId: string,
    options: { countTurn?: boolean } = {},
  ): Promise<void> {
    const persona = this.config.getPersona();
    if (!persona.metaPrompts || persona.metaPrompts.length === 0) {
      return;
    }

    const countTurn = options.countTurn !== false;
    if (countTurn) this.countedTurns += 1;
    const queuedAtTurn = this.countedTurns;
    const triggeredMetaPrompts: MetaPromptDefinition[] = [];
    const pendingEvents = this.config.getPendingEvents();

    for (const metaPrompt of persona.metaPrompts) {
      const trigger = metaPrompt.trigger;
      if (!trigger) continue;

      switch (trigger.type) {
        case 'turn_interval':
          if (countTurn && (await this.advanceTurnInterval(metaPrompt, trigger.intervalTurns))) {
            triggeredMetaPrompts.push(metaPrompt);
          }
          break;
        case 'event_based': {
          const eventName = trigger.eventName;
          if (pendingEvents.has(eventName as GMIEventType)) {
            triggeredMetaPrompts.push(metaPrompt);
            pendingEvents.delete(eventName as GMIEventType);
          }
          break;
        }
        case 'manual': {
          const manualFlag = await this.config.workingMemory.get<boolean>(
            `manual_trigger_${metaPrompt.id}`,
          );
          if (manualFlag) {
            triggeredMetaPrompts.push(metaPrompt);
            await this.config.workingMemory.delete(`manual_trigger_${metaPrompt.id}`);
          }
          break;
        }
        default: {
          // Persona JSON is cast rather than type-checked, so other trigger
          // types reach this point at runtime. Nothing ever fires them.
          const unsupportedType = String((trigger as { type?: unknown }).type);
          this.warnInvalidTrigger(
            metaPrompt,
            `trigger type '${unsupportedType}' is not supported (expected turn_interval, event_based or manual)`,
          );
        }
      }
    }

    if (triggeredMetaPrompts.length > 0) {
      this.config.addTraceEntry(
        'SELF_REFLECTION_TRIGGERED',
        `${triggeredMetaPrompts.length} metaprompt(s) triggered`,
        { ids: triggeredMetaPrompts.map((m) => m.id), turnId },
      );

      // Queue the batch and return: the turn does not wait for metaprompt LLM calls.
      void this.enqueue('Metaprompt execution', (run) => {
        // An event-based metaprompt reacts to the turn that raised the event
        // (a frustrated or confused message). If a newer user turn has been
        // counted while this batch waited behind a slow one, that evidence is
        // gone, so it is dropped rather than applied to a later mood.
        const current = this.countedTurns === queuedAtTurn;
        const runnable = current
          ? triggeredMetaPrompts
          : triggeredMetaPrompts.filter((mp) => mp.trigger?.type !== 'event_based');
        if (runnable.length < triggeredMetaPrompts.length) {
          this.config.addTraceEntry('DEBUG', 'Skipped event-based metaprompts whose triggering turn has passed.', {
            ids: triggeredMetaPrompts.filter((mp) => !runnable.includes(mp)).map((mp) => mp.id),
          });
        }
        return this.executeMetaprompts(runnable, run);
      });
    }
  }

  /**
   * Reports whether a metaprompt batch or self-reflection cycle is queued or running.
   *
   * @returns `true` while any metaprompt work is pending.
   */
  public isRunning(): boolean {
    // A unit released at its deadline can leave a memory write running.
    return this.inFlight > 0 || this.writeTails.size > 0;
  }

  /**
   * Resolves once every queued metaprompt batch and self-reflection cycle has
   * settled, including work queued while waiting. Never rejects.
   */
  public async whenIdle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.queueTail;
      await tail;
      // Memory writes a unit started before its deadline outlive the unit.
      await Promise.all(this.writeTails.values());
    } while (tail !== this.queueTail || this.writeTails.size > 0);
  }

  /**
   * Waits for queued and running metaprompt work to settle, for at most
   * `timeoutMs`. The GMI calls this during shutdown so that a batch still in
   * flight can store its updates before working memory closes, while a
   * provider call that never settles cannot hold shutdown open.
   *
   * @param timeoutMs - Longest wait, in milliseconds.
   * @returns `true` when all work settled, `false` when the wait timed out.
   */
  public async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<boolean> {
    if (!this.isRunning()) return true;

    let resolveTimedOut!: (settled: boolean) => void;
    const timedOut = new Promise<boolean>((resolve) => {
      resolveTimedOut = resolve;
    });
    const timer = setTimeout(() => resolveTimedOut(false), timeoutMs);
    // Waiting on a hung provider call must not keep the process alive.
    (timer as unknown as { unref?: () => void }).unref?.();

    try {
      return await Promise.race([this.whenIdle().then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops the queue for good, as the GMI shuts down: work that has not started
   * is skipped, and results of work still running are discarded instead of
   * applied to memories that are closing.
   */
  public close(): void {
    this.closed = true;
  }

  /**
   * Chains one unit of metaprompt work onto the queue, so it starts only after
   * all earlier work has settled. A failure is logged to the console and the
   * reasoning trace, and the queue moves on to the next unit.
   *
   * @param label - Name used in failure logs (for example 'Metaprompt execution').
   * @param task - The work to run.
   * @returns A promise that settles when this unit finishes. It never rejects.
   */
  private enqueue(label: string, task: (run: MetapromptRun) => Promise<void>): Promise<void> {
    this.inFlight += 1;
    let overdue = false;
    const run: MetapromptRun = { isStale: () => overdue || this.closed };
    const unit = async (): Promise<void> => {
      if (this.closed) return;
      // A provider call that never settles would hold the queue forever;
      // past the deadline the queue moves on, and the unit's late results
      // are discarded (run.isStale()).
      const timeoutMs = this.runTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      try {
        const outcome = await Promise.race([task(run).then(() => 'done' as const), deadline]);
        if (outcome === 'timeout') {
          overdue = true;
          this.config.addTraceEntry('WARNING', `${label} did not finish within ${timeoutMs}ms; its results will be discarded.`);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const settled = this.queueTail
      .then(unit)
      .catch((error: unknown) => {
        console.error(`GMI (ID: ${this.config.getGmiId()}): ${label} failed:`, error);
        this.config.addTraceEntry('ERROR', `${label} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight -= 1;
      });
    this.queueTail = settled;
    return settled;
  }

  /**
   * Gets the turn counter for a specific metaprompt.
   *
   * Checks the in-memory map first, then falls back to working memory for
   * persistence across GMI instances.
   *
   * @param metapromptId - The metaprompt identifier.
   * @returns The current counter value.
   */
  public async getMetapromptTurnCounter(metapromptId: string): Promise<number> {
    const counter = this.metaPromptTriggerCounters.get(metapromptId);
    if (counter !== undefined) {
      return counter;
    }
    const storedCounter = await this.config.workingMemory.get<number>(
      `metaprompt_turn_counter_${metapromptId}`,
    );
    return storedCounter || 0;
  }

  /**
   * Increments the turn counter for a specific metaprompt.
   *
   * @param metapromptId - The metaprompt identifier.
   */
  public async incrementMetapromptTurnCounter(metapromptId: string): Promise<void> {
    const current = await this.getMetapromptTurnCounter(metapromptId);
    await this.setMetapromptTurnCounter(metapromptId, current + 1);
  }

  /**
   * Resets the turn counter for a specific metaprompt to zero.
   *
   * @param metapromptId - The metaprompt identifier.
   */
  public async resetMetapromptTurnCounter(metapromptId: string): Promise<void> {
    await this.setMetapromptTurnCounter(metapromptId, 0);
  }

  /**
   * Sets the turn counter for a specific metaprompt, in memory and in working
   * memory, where it survives across GMI instances.
   *
   * @param metapromptId - The metaprompt identifier.
   * @param value - The number of counted user turns since the metaprompt last fired.
   */
  public async setMetapromptTurnCounter(metapromptId: string, value: number): Promise<void> {
    this.metaPromptTriggerCounters.set(metapromptId, value);
    await this.config.workingMemory.set(`metaprompt_turn_counter_${metapromptId}`, value);
  }

  /**
   * Counts one user turn toward a `turn_interval` metaprompt and reports
   * whether the metaprompt fires on it.
   *
   * The counter holds the user turns counted since the metaprompt last fired.
   * It is incremented first, so an interval of N fires on user turns N, 2N,
   * 3N and so on, and it resets to zero when the metaprompt fires. A counter
   * already above the interval fires on the next counted turn.
   *
   * Persona JSON is not type-checked, so the interval is validated here: a
   * value that is not a finite number of at least 1 never fires and is
   * reported once through `warnInvalidTrigger`.
   *
   * @param metaPrompt - The metaprompt whose counter advances.
   * @param intervalTurns - The trigger's `intervalTurns`, as read from the persona.
   * @returns `true` when the metaprompt fires on this turn.
   */
  private async advanceTurnInterval(
    metaPrompt: MetaPromptDefinition,
    intervalTurns: unknown,
  ): Promise<boolean> {
    if (typeof intervalTurns !== 'number' || !Number.isFinite(intervalTurns) || intervalTurns < 1) {
      this.warnInvalidTrigger(
        metaPrompt,
        `intervalTurns must be a number >= 1 (got ${String(intervalTurns)})`,
      );
      return false;
    }

    const counted = (await this.getMetapromptTurnCounter(metaPrompt.id)) + 1;
    if (counted >= Math.floor(intervalTurns)) {
      await this.resetMetapromptTurnCounter(metaPrompt.id);
      return true;
    }
    await this.setMetapromptTurnCounter(metaPrompt.id, counted);
    return false;
  }

  /**
   * Reports a metaprompt whose trigger can never fire. Each metaprompt id is
   * reported once per executor, with one WARNING trace entry and one console
   * warning, so a misconfigured persona does not flood the trace every turn.
   *
   * @param metaPrompt - The metaprompt that will not run.
   * @param reason - Why its trigger cannot fire.
   */
  private warnInvalidTrigger(metaPrompt: MetaPromptDefinition, reason: string): void {
    if (this.invalidTriggerWarnings.has(metaPrompt.id)) return;
    this.invalidTriggerWarnings.add(metaPrompt.id);

    const message = `Metaprompt '${metaPrompt.id}' will not run: ${reason}.`;
    console.warn(`GMI (ID: ${this.config.getGmiId()}): ${message}`);
    this.config.addTraceEntry('WARNING', message, {
      metapromptId: metaPrompt.id,
      trigger: metaPrompt.trigger,
    });
  }

  /**
   * Executes one batch of metaprompts in parallel using `Promise.allSettled`.
   *
   * A failed metaprompt is recorded as an ERROR trace entry and does not stop
   * the others. The batch never changes the GMI's lifecycle state: it runs in
   * the background, so the turn that triggered it may have finished and a
   * later turn may be in progress. {@link MetapromptExecutor.checkAndTriggerMetaprompts}
   * queues batches so that they run one at a time.
   *
   * @param metaPrompts - The metaprompt definitions to execute.
   */
  public async executeMetaprompts(metaPrompts: MetaPromptDefinition[], run?: MetapromptRun): Promise<void> {
    if (metaPrompts.length === 0) return;

    this.config.addTraceEntry(
      'SELF_REFLECTION_START',
      `Executing ${metaPrompts.length} metaprompt(s)`,
      { ids: metaPrompts.map((m) => m.id) },
    );

    try {
      const results = await Promise.allSettled(
        metaPrompts.map((mp) => this.executeMetapromptHandler(mp, run)),
      );

      results.forEach((result, idx) => {
        if (result.status === 'rejected') {
          this.config.addTraceEntry(
            'ERROR',
            `Metaprompt '${metaPrompts[idx].id}' failed: ${result.reason}`,
            { error: result.reason },
          );
        }
      });
    } catch (error: any) {
      const gmiError = createGMIErrorFromError(
        error,
        GMIErrorCode.GMI_PROCESSING_ERROR,
        undefined,
        'Error during metaprompt execution',
      );
      this.config.addTraceEntry(
        'ERROR',
        gmiError.message,
        gmiError.toPlainObject(),
      );
    } finally {
      this.config.addTraceEntry(
        'SELF_REFLECTION_COMPLETE',
        'Metaprompt execution cycle complete',
      );
    }
  }

  /**
   * Routes a metaprompt to its appropriate handler based on its ID.
   *
   * Known IDs have dedicated handlers; unknown IDs fall through to the
   * generic handler.
   *
   * @param metaPrompt - The metaprompt definition to execute.
   */
  public async executeMetapromptHandler(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    switch (metaPrompt.id) {
      case 'gmi_self_trait_adjustment':
        return this.handleTraitAdjustment(metaPrompt, run);
      case 'gmi_frustration_recovery':
        return this.handleFrustrationRecovery(metaPrompt, run);
      case 'gmi_confusion_clarification':
        return this.handleConfusionClarification(metaPrompt, run);
      case 'gmi_satisfaction_reinforcement':
        return this.handleSatisfactionReinforcement(metaPrompt, run);
      case 'gmi_error_recovery':
        return this.handleErrorRecovery(metaPrompt, run);
      case 'gmi_engagement_boost':
        return this.handleEngagementBoost(metaPrompt, run);
      default:
        return this.handleGenericMetaprompt(metaPrompt, run);
    }
  }

  /**
   * Handler for the trait adjustment metaprompt (self-reflection).
   *
   * Gathers recent conversation history, reasoning trace, mood, and contexts
   * as evidence, then executes the metaprompt template with variable substitution.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleTraitAdjustment(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const evidenceHistory = this.config.getConversationHistory().slice(-10);
    const evidenceTrace = this.config.getReasoningTraceEntries().slice(-20);

    const evidence = {
      recentHistory: evidenceHistory,
      recentReasoning: evidenceTrace,
      currentMood: this.config.getMood(),
      userContext: this.config.getUserContext(),
      taskContext: this.config.getTaskContext(),
    };

    const variables = {
      evidence: JSON.stringify(evidence).substring(0, 4000),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Handler for the frustration recovery metaprompt.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleFrustrationRecovery(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const sentimentHistory = await this.config.workingMemory.get<SentimentHistoryState>(
      'gmi_sentiment_history',
    );
    const recentErrors = this.config.getReasoningTraceEntries()
      .slice(-10)
      .filter((e) => e.type === ('ERROR' as ReasoningEntryType));

    const variables = {
      current_sentiment: this.config.getUserContext().currentSentiment || 'negative',
      sentiment_score: (sentimentHistory?.trends[sentimentHistory.trends.length - 1]?.score || -0.5).toString(),
      consecutive_frustration: (sentimentHistory?.consecutiveFrustration || 1).toString(),
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      recent_errors: JSON.stringify(recentErrors.map((e) => e.message)),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Handler for the confusion clarification metaprompt.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleConfusionClarification(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const sentimentHistory = await this.config.workingMemory.get<SentimentHistoryState>(
      'gmi_sentiment_history',
    );

    const lastConfusionEvent = this.config.getEventHistory()
      .slice()
      .reverse()
      .find((e) => e.eventType === GMIEventType.USER_CONFUSED);

    const variables = {
      current_sentiment: this.config.getUserContext().currentSentiment || 'neutral',
      consecutive_confusion: (sentimentHistory?.consecutiveConfusion || 1).toString(),
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      confusion_keywords: lastConfusionEvent?.metadata.triggerKeywords
        ? JSON.stringify(lastConfusionEvent.metadata.triggerKeywords)
        : '[]',
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Handler for the satisfaction reinforcement metaprompt.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleSatisfactionReinforcement(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const sentimentHistory = await this.config.workingMemory.get<SentimentHistoryState>(
      'gmi_sentiment_history',
    );

    const variables = {
      current_sentiment: this.config.getUserContext().currentSentiment || 'positive',
      sentiment_score: (sentimentHistory?.trends[sentimentHistory.trends.length - 1]?.score || 0.5).toString(),
      consecutive_satisfaction: (sentimentHistory?.consecutiveSatisfaction || 1).toString(),
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Handler for the error recovery metaprompt.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleErrorRecovery(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const recentErrors = this.config.getReasoningTraceEntries()
      .slice(-10)
      .filter((e) => e.type === ('ERROR' as ReasoningEntryType));

    const variables = {
      recent_errors: JSON.stringify(recentErrors.map((e) => ({ message: e.message, details: e.details }))),
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Handler for the engagement boost metaprompt.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleEngagementBoost(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const sentimentHistory = await this.config.workingMemory.get<SentimentHistoryState>(
      'gmi_sentiment_history',
    );

    const variables = {
      consecutive_neutral: (sentimentHistory?.consecutiveConfusion || 4).toString(),
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Generic handler for custom metaprompts that don't have a dedicated handler.
   *
   * Provides all available context variables for maximum flexibility.
   *
   * @param metaPrompt - The metaprompt definition.
   */
  public async handleGenericMetaprompt(metaPrompt: MetaPromptDefinition, run?: MetapromptRun): Promise<void> {
    const variables = {
      recent_conversation: JSON.stringify(this.config.getConversationHistory().slice(-5)),
      recent_reasoning: JSON.stringify(this.config.getReasoningTraceEntries().slice(-10)),
      current_mood: this.config.getMood(),
      user_skill: this.config.getUserContext().skillLevel || 'unknown',
      task_complexity: this.config.getTaskContext().complexity || 'unknown',
      current_sentiment: this.config.getUserContext().currentSentiment || 'neutral',
    };

    const response = await this.executeMetapromptWithVariables(metaPrompt, variables, run);
    await this.applyMetapromptUpdates(response, metaPrompt.id, run);
  }

  /**
   * Executes a metaprompt template with variable substitution and LLM call.
   *
   * 1. Extracts the template string from the metaprompt definition.
   * 2. Substitutes `{{variable}}` placeholders with provided values.
   * 3. Resolves the model and provider: the metaprompt's own, then the
   *    persona defaults, then the GMI defaults.
   * 4. Calls the LLM with JSON response format.
   * 5. Parses the JSON response with LLM-based recovery via IUtilityAI.
   *
   * @param metaPrompt - The metaprompt definition.
   * @param variables - Key-value pairs to substitute into the template.
   * @returns The parsed JSON response from the LLM.
   */
  public async executeMetapromptWithVariables(
    metaPrompt: MetaPromptDefinition,
    variables: Record<string, string>,
    run?: MetapromptRun,
  ): Promise<any> {
    let template: string;
    if (typeof metaPrompt.promptTemplate === 'string') {
      template = metaPrompt.promptTemplate;
    } else {
      template = metaPrompt.promptTemplate.template;
    }

    let finalPrompt = template;
    for (const [key, value] of Object.entries(variables)) {
      finalPrompt = finalPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }

    // Same resolution as the self-reflection path: the metaprompt's own model
    // and provider, then the persona defaults, then the GMI's configured
    // defaults. Throws a CONFIGURATION_ERROR GMIError when nothing resolves.
    const { modelId, providerId } = this.config.getModelAndProvider(
      metaPrompt.modelId,
      metaPrompt.providerId,
    );

    this.config.addTraceEntry(
      'DEBUG',
      `Executing metaprompt '${metaPrompt.id}'`,
      { modelId, providerId },
    );

    const completionOptions: ModelCompletionOptions = {
      temperature: metaPrompt.temperature ?? 0.3,
      maxTokens: metaPrompt.maxOutputTokens ?? 512,
      responseFormat: { type: 'json_object' },
      // Bounds a stalled provider call before the queue's own deadline does.
      requestTimeout: this.runTimeoutMs,
    };

    const provider = this.config.llmProviderManager.getProvider(providerId);
    if (!provider) {
      throw new GMIError(
        `Provider '${providerId}' not found for metaprompt '${metaPrompt.id}'.`,
        GMIErrorCode.LLM_PROVIDER_UNAVAILABLE,
      );
    }

    // A run can go stale while its handler awaits memory reads; it then
    // starts no provider call whose answer would be discarded.
    if (run?.isStale()) {
      this.config.addTraceEntry('WARNING', `Discarded late results of metaprompt '${metaPrompt.id}'.`);
      return null;
    }

    const result = await provider.generateCompletion(
      modelId,
      [{ role: 'user', content: finalPrompt }],
      completionOptions,
    );

    const responseContent = result.choices?.[0]?.message?.content;
    if (!responseContent || typeof responseContent !== 'string') {
      throw new GMIError(
        `Metaprompt '${metaPrompt.id}' returned no valid content.`,
        GMIErrorCode.LLM_PROVIDER_ERROR,
        { response: result },
      );
    }

    // A run that went stale while the provider answered is discarded anyway,
    // so no JSON repair call is made on its behalf.
    if (run?.isStale()) {
      this.config.addTraceEntry('WARNING', `Discarded late results of metaprompt '${metaPrompt.id}'.`);
      return null;
    }

    const parseOptions: ParseJsonOptions = {
      attemptFixWithLLM: true,
      llmModelIdForFix: modelId,
      llmProviderIdForFix: providerId,
    };

    const parsedResponse = await this.config.utilityAI.parseJsonSafe(
      responseContent,
      parseOptions,
    );

    return parsedResponse;
  }

  /**
   * Applies parsed metaprompt updates to GMI state via callbacks.
   *
   * Supports mood updates, user skill level updates, task complexity updates,
   * and memory imprints. State changes are logged via the trace entry callback.
   *
   * @param updates - The parsed updates from the metaprompt LLM response.
   * @param metapromptId - The ID of the metaprompt that produced these updates.
   * @param run - The queued unit applying them; once it is stale, nothing
   *   more is applied.
   * @returns Keys of the memory imprints stored.
   */
  public async applyMetapromptUpdates(updates: any, metapromptId: string, run?: MetapromptRun): Promise<string[]> {
    const storedImprintKeys: string[] = [];
    if (!updates) return storedImprintKeys;
    if (run?.isStale()) {
      // The queue moved on without this unit, or the GMI shut down: its
      // results would land on state that no longer matches its evidence.
      this.config.addTraceEntry('WARNING', `Discarded late results of metaprompt '${metapromptId}'.`);
      return storedImprintKeys;
    }

    let stateChanged = false;

    // Mood update — GMIMood enum values are lowercase (e.g., 'focused'),
    // but LLM responses may return either case. Normalize to lowercase for comparison.
    if (updates.updatedGmiMood) {
      const validMoods = Object.values(GMIMood) as string[];
      const normalizedMood = String(updates.updatedGmiMood).toLowerCase();
      if (validMoods.includes(normalizedMood) && this.config.getMood() !== normalizedMood) {
        this.config.onMoodUpdate(normalizedMood as GMIMood);
        stateChanged = true;
      }
    }

    // User skill level update
    const userCtx = this.config.getUserContext();
    if (updates.updatedUserSkillLevel &&
        userCtx.skillLevel !== updates.updatedUserSkillLevel) {
      this.config.onUserContextUpdate({ skillLevel: updates.updatedUserSkillLevel });
      stateChanged = true;
    }

    // Task complexity update
    const taskCtx = this.config.getTaskContext();
    if (updates.updatedTaskComplexity &&
        taskCtx.complexity !== updates.updatedTaskComplexity) {
      this.config.onTaskContextUpdate({ complexity: updates.updatedTaskComplexity });
      stateChanged = true;
    }

    // Memory imprints
    if (updates.newMemoryImprints && Array.isArray(updates.newMemoryImprints)) {
      for (const imprint of updates.newMemoryImprints) {
        // A write can outlast the run's deadline. Once the queue has moved
        // on or the GMI has shut down, the remaining imprints would overwrite
        // newer values or reach a closed memory, so they are dropped.
        if (run?.isStale()) {
          this.config.addTraceEntry('WARNING', `Discarded late results of metaprompt '${metapromptId}'.`);
          break;
        }
        if (imprint.key && isGmiStateKey(imprint.key)) {
          this.config.addTraceEntry('WARNING', `Skipped memory imprint '${imprint.key}' from metaprompt '${metapromptId}': the key holds GMI state.`);
          continue;
        }
        if (imprint.key) {
          const stored = await this.writeInOrder(run, imprint.key, () =>
            this.config.workingMemory.set(imprint.key, imprint.value),
          );
          if (!stored) {
            this.config.addTraceEntry('WARNING', `Discarded late results of metaprompt '${metapromptId}'.`);
            break;
          }
          storedImprintKeys.push(imprint.key);
          stateChanged = true;
        }
      }
    }

    // Log state change
    if (stateChanged) {
      this.config.addTraceEntry(
        'STATE_CHANGE',
        `GMI state updated by metaprompt '${metapromptId}'`,
        {
          newMood: this.config.getMood(),
          newUserSkill: this.config.getUserContext().skillLevel,
          newTaskComplexity: this.config.getTaskContext().complexity,
          rationale: updates.adjustmentRationale || updates.recoveryStrategy || updates.clarificationStrategy || updates.engagementStrategy || updates.mitigationStrategy,
        },
      );
    }
    return storedImprintKeys;
  }

  /**
   * Runs one memory write after every write to the same key queued before
   * it, unless `run` has gone stale by the time its turn comes.
   *
   * @param run The unit making the write.
   * @param key The working-memory key written.
   * @param write The write itself.
   * @returns Whether the write ran.
   */
  private writeInOrder(run: MetapromptRun | undefined, key: string, write: () => Promise<void>): Promise<boolean> {
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (run?.isStale()) return false;
      await write();
      return true;
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(key, tail);
    // Forget the key once its last queued write settles.
    void tail.then(() => {
      if (this.writeTails.get(key) === tail) this.writeTails.delete(key);
    });
    return result;
  }

  /**
   * Triggers and processes a full self-reflection cycle using the
   * `gmi_self_trait_adjustment` metaprompt.
   *
   * Performs the same work as `handleTraitAdjustment`, behind two guards: the
   * cycle is skipped when the persona defines no such metaprompt, and when a
   * metaprompt batch or another cycle is already queued or running. The cycle
   * runs on the metaprompt queue and never changes the GMI's lifecycle state.
   * The returned promise settles when the cycle has finished.
   */
  public async triggerAndProcessSelfReflection(): Promise<void> {
    const persona = this.config.getPersona();
    const reflectionMetaPromptDef = persona.metaPrompts?.find(
      (mp) => mp.id === 'gmi_self_trait_adjustment',
    );
    if (!reflectionMetaPromptDef?.promptTemplate) {
      this.config.addTraceEntry(
        'SELF_REFLECTION_SKIPPED',
        "Self-reflection disabled or no 'gmi_self_trait_adjustment' meta-prompt.",
      );
      return;
    }
    if (this.isRunning()) {
      this.config.addTraceEntry(
        'SELF_REFLECTION_SKIPPED',
        'Self-reflection already in progress.',
      );
      return;
    }

    await this.enqueue('Self-reflection', (run) => this.runSelfReflectionCycle(reflectionMetaPromptDef, run));
  }

  /**
   * Runs one self-reflection cycle for the `gmi_self_trait_adjustment`
   * metaprompt: gathers evidence, calls the LLM, and applies the parsed
   * updates. Errors are recorded in the reasoning trace and not rethrown.
   *
   * @param reflectionMetaPromptDef - The `gmi_self_trait_adjustment` definition.
   */
  private async runSelfReflectionCycle(
    reflectionMetaPromptDef: MetaPromptDefinition,
    run?: MetapromptRun,
  ): Promise<void> {
    this.config.addTraceEntry('SELF_REFLECTION_START', 'Starting self-reflection cycle.');

    try {
      const evidence = {
        recentConversation: this.config.getConversationHistory().slice(-10),
        recentTraceEntries: this.config.getReasoningTraceEntries().slice(-20),
        currentMood: this.config.getMood(),
        currentUserContext: this.config.getUserContext(),
        currentTaskContext: this.config.getTaskContext(),
      };
      this.config.addTraceEntry(
        'SELF_REFLECTION_DETAIL',
        'Gathered evidence for reflection.',
        {
          conversationSampleCount: evidence.recentConversation.length,
          traceSampleCount: evidence.recentTraceEntries.length,
        },
      );

      let metaPromptText =
        typeof reflectionMetaPromptDef.promptTemplate === 'string'
          ? reflectionMetaPromptDef.promptTemplate
          : reflectionMetaPromptDef.promptTemplate.template;

      metaPromptText = metaPromptText
        .replace(/\{\{\s*evidence\s*\}\}/gi, JSON.stringify(evidence).substring(0, 4000) + '...')
        .replace(/\{\{\s*current_mood\s*\}\}/gi, this.config.getMood())
        .replace(/\{\{\s*user_skill\s*\}\}/gi, this.config.getUserContext().skillLevel || 'unknown')
        .replace(/\{\{\s*task_complexity\s*\}\}/gi, this.config.getTaskContext().complexity || 'unknown');

      this.config.addTraceEntry(
        'SELF_REFLECTION_DETAIL',
        'Constructed meta-prompt.',
        { preview: metaPromptText.substring(0, 100) },
      );

      const { modelId, providerId } = this.config.getModelAndProvider(
        reflectionMetaPromptDef.modelId,
        reflectionMetaPromptDef.providerId,
      );
      const provider = this.config.llmProviderManager.getProvider(providerId);
      if (!provider) {
        throw new GMIError(
          `Provider '${providerId}' not found for self-reflection.`,
          GMIErrorCode.LLM_PROVIDER_UNAVAILABLE,
        );
      }

      if (run?.isStale()) {
        this.config.addTraceEntry('WARNING', "Discarded late results of metaprompt 'gmi_self_trait_adjustment'.");
        return;
      }

      const llmResponse = await provider.generateCompletion(
        modelId,
        [{ role: 'user', content: metaPromptText }],
        {
          maxTokens: reflectionMetaPromptDef.maxOutputTokens || 512,
          temperature: reflectionMetaPromptDef.temperature || 0.3,
          responseFormat: { type: 'json_object' },
          requestTimeout: this.runTimeoutMs,
        },
      );

      const responseContent = llmResponse.choices?.[0]?.message?.content;
      if (!responseContent || typeof responseContent !== 'string') {
        throw new GMIError(
          'Self-reflection LLM call returned no valid content.',
          GMIErrorCode.LLM_PROVIDER_ERROR,
          { response: llmResponse },
        );
      }
      this.config.addTraceEntry(
        'SELF_REFLECTION_DETAIL',
        'LLM response for reflection received.',
        { preview: responseContent.substring(0, 100) },
      );

      // A cycle that went stale while the provider answered is discarded
      // anyway, so no JSON repair call is made on its behalf.
      if (run?.isStale()) {
        this.config.addTraceEntry('WARNING', "Discarded late results of metaprompt 'gmi_self_trait_adjustment'.");
        return;
      }

      const parseOptions: ParseJsonOptions = {
        attemptFixWithLLM: true,
        llmModelIdForFix: reflectionMetaPromptDef.modelId || modelId,
        llmProviderIdForFix: reflectionMetaPromptDef.providerId || providerId,
      };
      type ExpectedReflectionOutput = {
        updatedGmiMood?: GMIMood;
        updatedUserSkillLevel?: string;
        updatedTaskComplexity?: string;
        adjustmentRationale?: string;
        newMemoryImprints?: Array<{ key: string; value: any; description?: string }>;
      };
      const parsedUpdates = await this.config.utilityAI.parseJsonSafe<ExpectedReflectionOutput>(
        responseContent,
        parseOptions,
      );

      if (!parsedUpdates) {
        throw new GMIError(
          'Failed to parse/fix JSON from self-reflection LLM.',
          GMIErrorCode.PARSING_ERROR,
          { responseText: responseContent },
        );
      }
      this.config.addTraceEntry(
        'SELF_REFLECTION_DETAIL',
        'Parsed trait update suggestions.',
        { suggestions: parsedUpdates },
      );

      // Apply updates via callbacks
      const storedImprintKeys = await this.applyMetapromptUpdates(parsedUpdates, 'gmi_self_trait_adjustment', run);

      // Trace only the imprints that were stored: a late or stale run
      // stores none, and later reflections read this trace as evidence.
      if (storedImprintKeys.length > 0) {
        this.config.addTraceEntry(
          'STATE_CHANGE',
          'New memory imprints added from self-reflection.',
          { imprints: storedImprintKeys },
        );
      }

      if (parsedUpdates.adjustmentRationale) {
        this.config.addTraceEntry(
          'SELF_REFLECTION_DETAIL',
          'Self-reflection rationale recorded.',
          { rationale: parsedUpdates.adjustmentRationale },
        );
      }
    } catch (error: any) {
      const gmiError = createGMIErrorFromError(
        error,
        GMIErrorCode.GMI_PROCESSING_ERROR,
        undefined,
        'Error during self-reflection.',
      );
      this.config.addTraceEntry(
        'ERROR',
        `Self-reflection failed: ${gmiError.message}`,
        gmiError.toPlainObject(),
      );
      console.error(`GMI (ID: ${this.config.getGmiId()}) self-reflection error:`, gmiError);
    } finally {
      this.config.addTraceEntry(
        'SELF_REFLECTION_COMPLETE',
        'Self-reflection cycle finished.',
      );
    }
  }
}
