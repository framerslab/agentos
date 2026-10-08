/**
 * @fileoverview SelfEvaluateTool — ITool implementation that enables agents to
 * evaluate their own response quality, adjust runtime parameters, and report
 * on performance drift over a session.
 *
 * @module @framers/agentos/emergent/SelfEvaluateTool
 *
 * Three actions:
 * - `evaluate` — Score a response using an LLM judge (via generateText).
 * - `adjust`   — Tweak runtime parameters (temperature, verbosity) or
 *   delegate personality adjustments to {@link AdaptPersonalityTool}.
 * - `report`   — Aggregate session evaluation history, compute score averages,
 *   and list all adjustments made.
 *
 * The tool mutates session state during `adjust`, either by delegating to
 * `adapt_personality` or by updating ephemeral runtime parameters.
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import { generateText } from '../../api/generateText.js';
import { PROVIDER_DEFAULTS, autoDetectProvider } from '../../api/runtime/provider-defaults.js';
import { VALID_TRAITS, type AdaptPersonalityTool, type HEXACOTrait } from './AdaptPersonalityTool.js';
import { resolveSelfImprovementSessionKey } from './sessionScope.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Score dimensions returned by the LLM evaluation judge.
 */
export interface EvaluationScores {
  /** How relevant the response is to the user's query (0–1). */
  relevance: number;
  /** How clear and well-structured the response is (0–1). */
  clarity: number;
  /** How accurate the factual content is (0–1). */
  accuracy: number;
  /** How helpful the response is for the user's goal (0–1). */
  helpfulness: number;
}

/**
 * A recorded evaluation with scores and timestamp.
 */
export interface EvaluationRecord {
  /** The scores assigned by the LLM judge. */
  scores: EvaluationScores;
  /** ISO-8601 timestamp of when the evaluation was performed. */
  timestamp: string;
}

/**
 * A recorded parameter adjustment.
 */
export interface AdjustmentRecord {
  /** The parameter that was adjusted. */
  param: string;
  /** Value before adjustment. */
  prev: unknown;
  /** Value after adjustment. */
  new: unknown;
  /** ISO-8601 timestamp of when the adjustment was made. */
  timestamp: string;
}

interface SuggestedAdjustment {
  param: string;
  value: unknown;
  reasoning?: string;
}

interface ParsedEvaluation {
  scores: EvaluationScores;
  adjustments: SuggestedAdjustment[];
}

/**
 * Memory trace stored via the optional storeMemory callback.
 */
export interface MemoryTrace {
  /** Trace type identifier. */
  type: string;
  /**
   * Scope of the trace (e.g. 'session'). The AgentOS host stores 'session'
   * traces under the memory `thread` scope of the calling conversation.
   */
  scope: string;
  /** Serialized trace content. */
  content: string;
  /** Tags for categorization and retrieval. */
  tags: string[];
}

interface SelfEvaluateSessionState {
  evaluations: EvaluationRecord[];
  adjustments: AdjustmentRecord[];
  params: Map<string, unknown>;
  evalCount: number;
}

// ============================================================================
// INPUT TYPE
// ============================================================================

/**
 * Input arguments accepted by the `self_evaluate` tool.
 * Discriminated on the `action` field.
 */
export interface SelfEvaluateInput extends Record<string, any> {
  /** The action to perform: evaluate, adjust, or report. */
  action: 'evaluate' | 'adjust' | 'report';

  // --- evaluate fields ---
  /** The response text to evaluate (required for evaluate). */
  response?: string;
  /** The original user query for context (required for evaluate). */
  query?: string;

  // --- adjust fields ---
  /** The parameter to adjust (required for adjust). */
  param?: string;
  /** The new value for the parameter (required for adjust). */
  value?: unknown;
  /** Reasoning for personality adjustments (required when param is a personality trait). */
  reasoning?: string;
}

// ============================================================================
// CONSTRUCTOR DEPS
// ============================================================================

/**
 * Dependencies injected into the {@link SelfEvaluateTool} constructor.
 */
export interface SelfEvaluateDeps {
  /** Configuration controlling auto-adjust behaviour and evaluation limits. */
  config: {
    /** Whether adjustments are applied automatically after evaluations. */
    autoAdjust: boolean;
    /** Parameters that may be adjusted (e.g. 'temperature', 'verbosity', 'openness'). */
    adjustableParams: string[];
    /** Maximum number of evaluations allowed per session. */
    maxEvaluationsPerSession: number;
    /** Optional explicit model override for the evaluation judge. */
    evaluationModel?: string;
  };
  /** Optional AdaptPersonalityTool for delegating personality adjustments. */
  adaptPersonality?: AdaptPersonalityTool;
  /**
   * Optional callback to persist evaluation traces to long-term memory.
   * Receives the tool's execution context so the host can store the trace in
   * the calling agent's memory, scoped to the calling session.
   */
  storeMemory?: (trace: MemoryTrace, context?: ToolExecutionContext) => Promise<void>;
  /** Optional override for tests or custom judge routing. */
  generateTextImpl?: typeof generateText;
  /** Optional host-level getter for session runtime parameters. */
  getSessionParam?: (param: string, context: ToolExecutionContext) => unknown;
  /** Optional host-level setter for session runtime parameters. */
  setSessionParam?: (param: string, value: unknown, context: ToolExecutionContext) => void;
}

// ============================================================================
// TOOL IMPLEMENTATION
// ============================================================================

/**
 * ITool implementation enabling agents to evaluate their own responses,
 * adjust runtime parameters, and generate performance reports.
 *
 * @example
 * ```ts
 * const tool = new SelfEvaluateTool({
 *   config: {
 *     autoAdjust: false,
 *     adjustableParams: ['temperature', 'verbosity'],
 *     maxEvaluationsPerSession: 20,
 *   },
 * });
 *
 * const result = await tool.execute({
 *   action: 'evaluate',
 *   response: 'The capital of France is Paris.',
 *   query: 'What is the capital of France?',
 * }, context);
 * ```
 */
export class SelfEvaluateTool implements ITool<SelfEvaluateInput> {
  /** @inheritdoc */
  readonly id = 'com.framers.emergent.self-evaluate';

  /** @inheritdoc */
  readonly name = 'self_evaluate';

  /** @inheritdoc */
  readonly displayName = 'Self Evaluate';

  /** @inheritdoc */
  readonly description =
    'Evaluate response quality, adjust runtime parameters, or generate a ' +
    'performance report. Evaluate uses an LLM judge to score relevance, ' +
    'clarity, accuracy, and helpfulness.';

  /** @inheritdoc */
  readonly category = 'emergent';

  /** @inheritdoc */
  readonly hasSideEffects = true;

  /** @inheritdoc */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['evaluate', 'adjust', 'report'],
        description: 'The self-evaluation action to perform.',
      },
      response: {
        type: 'string',
        description: 'The response text to evaluate.',
      },
      query: {
        type: 'string',
        description: 'The original user query for evaluation context.',
      },
      param: {
        type: 'string',
        description: 'The parameter to adjust.',
      },
      value: {
        description: 'The new value for the parameter.',
      },
      reasoning: {
        type: 'string',
        description: 'Reasoning for personality trait adjustments.',
      },
    },
    required: ['action'],
  };

  /** Mutable self-evaluation state keyed by session identity. */
  private readonly sessionStates: Map<string, SelfEvaluateSessionState> = new Map();

  /** Injected dependencies. */
  private readonly deps: SelfEvaluateDeps;

  /**
   * Create a new SelfEvaluateTool.
   *
   * @param deps - Injected dependencies including config, optional
   *   adaptPersonality tool, and optional memory store callback.
   */
  constructor(deps: SelfEvaluateDeps) {
    this.deps = deps;
  }

  // --------------------------------------------------------------------------
  // EXECUTE
  // --------------------------------------------------------------------------

  /**
   * Execute the requested self-evaluation action.
   *
   * @param args - Action type and associated parameters.
   * @param context - Tool execution context.
   * @returns A {@link ToolExecutionResult} wrapping the action outcome.
   */
  async execute(
    args: SelfEvaluateInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    switch (args.action) {
      case 'evaluate':
        return this.handleEvaluate(args, context);
      case 'adjust':
        return this.handleAdjust(args, context);
      case 'report':
        return this.handleReport(context);
      default:
        return {
          success: false,
          error: `Unknown action "${args.action}". Must be one of: evaluate, adjust, report`,
        };
    }
  }

  // --------------------------------------------------------------------------
  // EVALUATE
  // --------------------------------------------------------------------------

  /**
   * Evaluate a response using an LLM judge and record the scores.
   *
   * Calls generateText with a small model to produce structured JSON scores,
   * then persists the evaluation as a memory trace if storeMemory is provided.
   */
  private async handleEvaluate(
    args: SelfEvaluateInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { response, query } = args;

    if (!response || typeof response !== 'string') {
      return { success: false, error: 'response is required for the evaluate action' };
    }
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'query is required for the evaluate action' };
    }

    // Check session evaluation limit
    const sessionState = this.getSessionState(context);

    if (sessionState.evalCount >= this.deps.config.maxEvaluationsPerSession) {
      return {
        success: false,
        error: `Maximum evaluations per session reached (${this.deps.config.maxEvaluationsPerSession})`,
      };
    }

    // Call LLM to produce evaluation scores
    let scores: EvaluationScores;
    try {
      const result = await (this.deps.generateTextImpl ?? generateText)({
        model: this.resolveEvaluationModel(),
        system: this.buildEvaluationPrompt(),
        prompt: `User query: ${query}\n\nResponse to evaluate: ${response}`,
        temperature: 0,
        maxTokens: 200,
      });

      const parsed = this.parseEvaluation(result.text);
      scores = parsed.scores;

      const autoAdjustResults = this.deps.config.autoAdjust
        ? await this.applySuggestedAdjustments(parsed.adjustments, context)
        : undefined;

      // Record the evaluation
      const record: EvaluationRecord = {
        scores,
        timestamp: new Date().toISOString(),
      };
      sessionState.evaluations.push(record);
      sessionState.evalCount++;

      // Store as memory trace if callback is provided. The trace carries the
      // user's query, so the context goes along to keep it in this session.
      if (this.deps.storeMemory) {
        try {
          await this.deps.storeMemory(
            {
              type: 'self-evaluation',
              scope: 'session',
              content: JSON.stringify({
                query,
                scores,
                autoAdjustments: autoAdjustResults?.appliedAdjustments ?? [],
              }),
              tags: ['evaluation', 'quality'],
            },
            context,
          );
        } catch {
          // Best-effort memory storage; don't fail the evaluation
        }
      }

      return {
        success: true,
        output: {
          scores,
          evalCount: sessionState.evalCount,
          remainingEvaluations:
            this.deps.config.maxEvaluationsPerSession - sessionState.evalCount,
          ...(autoAdjustResults ?? {}),
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Evaluation LLM call failed: ${err.message ?? String(err)}`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // ADJUST
  // --------------------------------------------------------------------------

  /**
   * Adjust a runtime parameter.
   *
   * For personality traits (openness, conscientiousness, etc.), delegates to
   * the injected AdaptPersonalityTool. For non-personality params (temperature,
   * verbosity), stores the value in session state.
   */
  private async handleAdjust(
    args: SelfEvaluateInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { param, value, reasoning } = args;
    const sessionState = this.getSessionState(context);

    if (!param || typeof param !== 'string') {
      return { success: false, error: 'param is required for the adjust action' };
    }
    if (value === undefined || value === null) {
      return { success: false, error: 'value is required for the adjust action' };
    }

    if (param === 'personality') {
      if (!this.deps.config.adjustableParams.includes('personality')) {
        return {
          success: false,
          error: `Parameter "${param}" is not adjustable. Allowed: ${this.deps.config.adjustableParams.join(', ')}`,
        };
      }

      const trait =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>).trait
          : undefined;
      const delta =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>).delta
          : undefined;

      if (!this.isPersonalityTrait(trait)) {
        return {
          success: false,
          error: `personality adjustments require a valid trait. Must be one of: ${VALID_TRAITS.join(', ')}`,
        };
      }
      if (typeof delta !== 'number' || !Number.isFinite(delta)) {
        return {
          success: false,
          error: 'personality adjustments require a finite numeric delta',
        };
      }

      return this.delegatePersonalityAdjustment(
        trait,
        delta,
        reasoning ?? `Self-evaluation adjustment for ${trait}`,
        context,
        sessionState,
      );
    }

    if (this.isPersonalityTrait(param)) {
      if (
        !this.deps.config.adjustableParams.includes(param) &&
        !this.deps.config.adjustableParams.includes('personality')
      ) {
        return {
          success: false,
          error: `Parameter "${param}" is not adjustable. Allowed: ${this.deps.config.adjustableParams.join(', ')}`,
        };
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          success: false,
          error: `Personality adjustment "${param}" requires a finite numeric delta`,
        };
      }

      return this.delegatePersonalityAdjustment(
        param,
        value,
        reasoning ?? `Self-evaluation adjustment for ${param}`,
        context,
        sessionState,
      );
    }

    if (!this.deps.config.adjustableParams.includes(param)) {
      return {
        success: false,
        error: `Parameter "${param}" is not adjustable. Allowed: ${this.deps.config.adjustableParams.join(', ')}`,
      };
    }

    // Non-personality parameter (temperature, verbosity, etc.)
    const prevValue =
      this.deps.getSessionParam?.(param, context) ?? sessionState.params.get(param);
    sessionState.params.set(param, value);
    this.deps.setSessionParam?.(param, value, context);

    sessionState.adjustments.push({
      param,
      prev: prevValue ?? null,
      new: value,
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      output: {
        param,
        previousValue: prevValue ?? null,
        newValue: value,
      },
    };
  }

  // --------------------------------------------------------------------------
  // REPORT
  // --------------------------------------------------------------------------

  /**
   * Generate a session performance report.
   *
   * Aggregates all evaluations, computes score averages, lists all adjustments,
   * and summarizes personality drift and skill changes.
   */
  private async handleReport(
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const sessionState = this.getSessionState(context, false);
    // Compute average scores across all evaluations
    const averages: EvaluationScores = {
      relevance: 0,
      clarity: 0,
      accuracy: 0,
      helpfulness: 0,
    };

    if (sessionState.evaluations.length > 0) {
      for (const evalRecord of sessionState.evaluations) {
        averages.relevance += evalRecord.scores.relevance;
        averages.clarity += evalRecord.scores.clarity;
        averages.accuracy += evalRecord.scores.accuracy;
        averages.helpfulness += evalRecord.scores.helpfulness;
      }

      const count = sessionState.evaluations.length;
      averages.relevance /= count;
      averages.clarity /= count;
      averages.accuracy /= count;
      averages.helpfulness /= count;
    }

    // Summarize personality drift from adjustments
    const personalityDrift: Record<string, { totalDelta: number; adjustmentCount: number }> = {};
    const paramAdjustments: AdjustmentRecord[] = [];

    for (const adj of sessionState.adjustments) {
      if (this.isPersonalityTrait(adj.param)) {
        if (!personalityDrift[adj.param]) {
          personalityDrift[adj.param] = { totalDelta: 0, adjustmentCount: 0 };
        }
        personalityDrift[adj.param].totalDelta +=
          (adj.new as number) - (adj.prev as number);
        personalityDrift[adj.param].adjustmentCount++;
      } else {
        paramAdjustments.push(adj);
      }
    }

    return {
      success: true,
      output: {
        totalEvaluations: sessionState.evaluations.length,
        averageScores: averages,
        adjustments: paramAdjustments,
        personalityDrift,
        evaluations: sessionState.evaluations,
      },
    };
  }

  private resolveEvaluationModel(): string {
    if (this.deps.config.evaluationModel) {
      return this.deps.config.evaluationModel;
    }

    const providerId = autoDetectProvider('text');
    const providerDefaults = providerId ? PROVIDER_DEFAULTS[providerId] : undefined;
    const modelId = providerDefaults?.cheap ?? providerDefaults?.text;

    if (providerId && modelId) {
      return `${providerId}:${modelId}`;
    }

    return 'openai:gpt-4o-mini';
  }

  private buildEvaluationPrompt(): string {
    const basePrompt =
      'You are a response quality evaluator. Score the following response on four dimensions: ' +
      'relevance, clarity, accuracy, and helpfulness. Each score is a number between 0 and 1.';

    if (!this.deps.config.autoAdjust || this.deps.config.adjustableParams.length === 0) {
      return `${basePrompt} Return ONLY a JSON object with these four keys, no other text.`;
    }

    return (
      `${basePrompt} Return ONLY JSON with numeric keys ` +
      `"relevance", "clarity", "accuracy", and "helpfulness". ` +
      `You MAY also include an "adjustments" array of recommended changes using only these allowed params: ` +
      `${this.deps.config.adjustableParams.join(', ')}. ` +
      `Each adjustment must be an object like {"param":"temperature","value":0.2,"reasoning":"..."} or ` +
      `{"param":"personality","value":{"trait":"openness","delta":0.05},"reasoning":"..."}. ` +
      `Only propose small bounded changes when they are clearly justified.`
    );
  }

  private parseEvaluation(rawText: string): ParsedEvaluation {
    const parsedPayload = this.extractJsonPayload(rawText);
    const parsedRecord =
      parsedPayload && typeof parsedPayload === 'object'
        ? (parsedPayload as Record<string, unknown>)
        : {};
    const nestedScores = parsedRecord.scores;
    const scoreSource =
      nestedScores && typeof nestedScores === 'object'
        ? (nestedScores as Record<string, unknown>)
        : parsedRecord;

    return {
      scores: {
        relevance: this.normalizeScore(scoreSource.relevance),
        clarity: this.normalizeScore(scoreSource.clarity),
        accuracy: this.normalizeScore(scoreSource.accuracy),
        helpfulness: this.normalizeScore(scoreSource.helpfulness),
      },
      adjustments: this.normalizeAdjustments(parsedRecord.adjustments),
    };
  }

  private extractJsonPayload(rawText: string): unknown {
    try {
      return JSON.parse(rawText);
    } catch {
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(rawText.slice(start, end + 1));
      }
      throw new Error('Evaluation model returned non-JSON output.');
    }
  }

  private normalizeScore(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : 0.5;
  }

  private normalizeAdjustments(value: unknown): SuggestedAdjustment[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized: SuggestedAdjustment[] = [];

    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const param = typeof record.param === 'string' ? record.param : undefined;
      const reasoning =
        typeof record.reasoning === 'string' ? record.reasoning : undefined;
      const adjustmentValue = record.value;

      if (!param || adjustmentValue === undefined) {
        continue;
      }

      normalized.push({
        param,
        value: adjustmentValue,
        reasoning,
      });
    }

    return normalized;
  }

  private isPersonalityTrait(param: unknown): param is HEXACOTrait {
    return typeof param === 'string' && VALID_TRAITS.includes(param as HEXACOTrait);
  }

  private async delegatePersonalityAdjustment(
    trait: HEXACOTrait,
    delta: number,
    reasoning: string,
    context: ToolExecutionContext,
    sessionState: SelfEvaluateSessionState,
  ): Promise<ToolExecutionResult> {
    if (!this.deps.adaptPersonality) {
      return {
        success: false,
        error: 'Personality adjustment requires AdaptPersonalityTool but none was provided.',
      };
    }

    const personalityResult = await this.deps.adaptPersonality.execute(
      { trait, delta, reasoning },
      context,
    );

    if (personalityResult.success && personalityResult.output) {
      sessionState.adjustments.push({
        param: trait,
        prev: personalityResult.output.previousValue,
        new: personalityResult.output.newValue,
        timestamp: new Date().toISOString(),
      });
    }

    return personalityResult;
  }

  private async applySuggestedAdjustments(
    adjustments: SuggestedAdjustment[],
    context: ToolExecutionContext,
  ): Promise<{
    appliedAdjustments: Array<{ param: string; output: unknown }>;
    skippedAdjustments: Array<{ param: string; reason: string }>;
  }> {
    const appliedAdjustments: Array<{ param: string; output: unknown }> = [];
    const skippedAdjustments: Array<{ param: string; reason: string }> = [];

    for (const adjustment of adjustments.slice(0, 3)) {
      const result = await this.handleAdjust(
        {
          action: 'adjust',
          param: adjustment.param,
          value: adjustment.value,
          reasoning: adjustment.reasoning,
        },
        context,
      );

      if (result.success) {
        appliedAdjustments.push({
          param: adjustment.param,
          output: result.output ?? null,
        });
      } else {
        skippedAdjustments.push({
          param: adjustment.param,
          reason: result.error ?? 'Unknown adjustment error',
        });
      }
    }

    return { appliedAdjustments, skippedAdjustments };
  }

  private getSessionState(
    context: ToolExecutionContext,
    createIfMissing = true,
  ): SelfEvaluateSessionState {
    const sessionKey = resolveSelfImprovementSessionKey(context);
    const existing = this.sessionStates.get(sessionKey);
    if (existing) {
      return existing;
    }

    const emptyState: SelfEvaluateSessionState = {
      evaluations: [],
      adjustments: [],
      params: new Map<string, unknown>(),
      evalCount: 0,
    };

    if (createIfMissing) {
      this.sessionStates.set(sessionKey, emptyState);
    }

    return emptyState;
  }
}
