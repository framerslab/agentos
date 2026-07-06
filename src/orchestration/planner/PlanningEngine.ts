/**
 * @file PlanningEngine.ts
 * @description Implementation of the AgentOS Planning Engine.
 * Provides autonomous goal pursuit, task decomposition, and self-correcting plans
 * using ReAct (Reasoning + Acting) and other cognitive patterns.
 *
 * @module AgentOS/Planning
 * @version 1.0.0
 *
 * @example
 * ```typescript
 * import { PlanningEngine } from '@framers/agentos/planning/planner';
 *
 * const engine = new PlanningEngine({
 *   llmProvider: aiModelProviderManager,
 *   defaultModelId: 'gpt-4o',
 * });
 *
 * const plan = await engine.generatePlan('Build a web scraper', {
 *   strategy: 'react',
 *   maxSteps: 10,
 * });
 * ```
 */

import type { ILogger } from '../../core/logging/ILogger';
import type { AIModelProviderManager } from '../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import { uuidv4 } from '../../core/utils/uuid';
import type {
  IPlanningEngine,
  ExecutionPlan,
  PlanStep,
  PlanStepResult,
  PlanActionType,
  PlanningOptions,
  PlanningContext,
  TaskDecomposition,
  SubTask,
  ExecutionFeedback,
  AutonomousLoopOptions,
  LoopProgress,
  PlanValidationResult,
  PlanValidationIssue,
  ReflectionResult,
  PlanAdjustment,
  ExecutionState,
  StepExecutionContext,
  ExecutionSummary,
} from './IPlanningEngine';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the PlanningEngine.
 */
export interface PlanningEngineConfig {
  /** LLM provider manager for generating plans */
  llmProvider: AIModelProviderManager;
  /** Default model ID for planning */
  defaultModelId?: string;
  /** Default provider ID */
  defaultProviderId?: string;
  /** Logger instance */
  logger?: ILogger;
  /** Default planning options */
  defaultOptions?: Partial<PlanningOptions>;
}

/**
 * Prompt templates for planning operations.
 */
const PLANNING_PROMPTS = {
  generatePlan: `You are an expert planning agent. Generate a detailed step-by-step plan to achieve the following goal.

GOAL: {goal}

CONTEXT:
{context}

AVAILABLE TOOLS:
{tools}

CONSTRAINTS:
- Maximum {maxSteps} steps
- Strategy: {strategy}
- {additionalConstraints}

Generate a plan in the following JSON format:
{
  "reasoning": "Your chain-of-thought reasoning for the plan",
  "steps": [
    {
      "action": {
        "type": "tool_call|reasoning|information_gathering|synthesis|validation",
        "toolId": "tool_name (if tool_call)",
        "toolArgs": { "arg": "value" },
        "content": "description of the action"
      },
      "reasoning": "Why this step is needed",
      "expectedOutcome": "What this step should produce",
      "dependsOn": ["step_ids"],
      "estimatedTokens": 100,
      "confidence": 0.85
    }
  ],
  "overallConfidence": 0.8
}`,

  decomposeTask: `Decompose the following complex task into simpler subtasks that can be executed independently or in sequence.

TASK: {task}

Provide a decomposition in JSON format:
{
  "reasoning": "How you broke down the task",
  "subtasks": [
    {
      "description": "Subtask description",
      "complexity": 1-10,
      "dependsOn": ["subtask_ids"],
      "estimatedTokens": 100,
      "parallelizable": true|false
    }
  ],
  "executionOrder": ["subtask_ids in order"]
}`,

  reflect: `Reflect on the current execution state and provide insights.

GOAL: {goal}
PLAN: {plan}
COMPLETED STEPS: {completedSteps}
CURRENT RESULTS: {results}
ISSUES ENCOUNTERED: {issues}

Analyze the execution and provide:
{
  "insights": ["Key observations"],
  "issues": ["Problems identified"],
  "adjustments": [
    {
      "type": "add_step|remove_step|modify_step|reorder",
      "targetStepId": "id",
      "reason": "Why this change"
    }
  ],
  "confidenceAdjustment": 0.1 (positive or negative),
  "recommendation": "continue|adjust|replan|abort"
}`,

  reactStep: `You are executing a plan step using the ReAct pattern.

GOAL: {goal}
CURRENT STEP: {step}
PREVIOUS RESULTS: {previousResults}
CONTEXT: {context}

Think through this step:
1. THOUGHT: What needs to be done and why
2. ACTION: The specific action to take
3. OBSERVATION: (Will be filled after execution)

Respond with your thought and action plan in JSON:
{
  "thought": "Your reasoning",
  "action": {
    "type": "tool_call|reasoning|synthesis",
    "details": { ... }
  },
  "expectedObservation": "What you expect to see"
}`,
};

// ============================================================================
// PlanningEngine Implementation
// ============================================================================

/**
 * Implementation of the AgentOS Planning Engine.
 *
 * Features:
 * - ReAct (Reasoning + Acting) pattern for interleaved planning and execution
 * - Plan-and-Execute for upfront planning
 * - Tree-of-Thought for exploring multiple reasoning paths
 * - Self-reflection and plan refinement
 * - Checkpoint and rollback support
 * - Human-in-the-loop integration points
 *
 * @implements {IPlanningEngine}
 */
export class PlanningEngine implements IPlanningEngine {
  private readonly llmProvider: AIModelProviderManager;
  private readonly defaultModelId: string;
  private readonly defaultProviderId?: string;
  private readonly logger?: ILogger;
  private readonly defaultOptions: PlanningOptions;

  /** Active execution states keyed by planId */
  private readonly executionStates = new Map<string, ExecutionState>();

  /** Saved checkpoints keyed by checkpointId */
  private readonly checkpoints = new Map<string, { plan: ExecutionPlan; state: ExecutionState }>();

  /**
   * Creates a new PlanningEngine instance.
   *
   * @param config - Engine configuration
   */
  constructor(config: PlanningEngineConfig) {
    this.llmProvider = config.llmProvider;
    // gpt-4-turbo (the old default) is a deprecated 2024-era model;
    // plan decomposition needs a current mid-tier reasoning model.
    this.defaultModelId = config.defaultModelId ?? 'gpt-4o';
    this.defaultProviderId = config.defaultProviderId;
    this.logger = config.logger;
    this.defaultOptions = {
      maxSteps: 15,
      maxIterations: 5,
      minConfidence: 0.6,
      allowToolUse: true,
      strategy: 'react',
      enableCheckpoints: true,
      checkpointFrequency: 5,
      maxTotalTokens: 100000,
      planningTimeoutMs: 60000,
      ...config.defaultOptions,
    };
  }

  // ==========================================================================
  // Plan Generation
  // ==========================================================================

  /**
   * Generates a multi-step execution plan from a high-level goal.
   *
   * @param goal - The high-level goal to achieve
   * @param context - Additional context for planning
   * @param options - Planning configuration options
   * @returns Generated execution plan
   */
  public async generatePlan(
    goal: string,
    context?: PlanningContext,
    options?: PlanningOptions,
  ): Promise<ExecutionPlan> {
    const opts = { ...this.defaultOptions, ...options };
    const startTime = Date.now();

    this.logger?.info?.('Generating execution plan', { goal, strategy: opts.strategy });

    try {
      // Build the planning prompt
      const prompt = this.buildPlanningPrompt(goal, context, opts);

      // Generate plan using LLM
      const response = await this.callLLM(prompt, { jsonMode: true });
      const planData = JSON.parse(response);

      // Build the execution plan
      const plan = this.buildExecutionPlan(goal, planData, opts, startTime);

      // Validate the generated plan
      const validation = await this.validatePlan(plan);
      if (!validation.isValid) {
        this.logger?.warn?.('Generated plan has validation issues', {
          planId: plan.planId,
          issues: validation.issues,
        });
      }

      this.logger?.info?.('Plan generated successfully', {
        planId: plan.planId,
        steps: plan.steps.length,
        confidence: plan.confidenceScore,
      });

      return plan;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to generate plan', { goal, error: errorMessage });
      throw new Error(`Planning failed: ${errorMessage}`);
    }
  }

  /**
   * Decomposes a complex task into simpler subtasks.
   *
   * @param task - The task description to decompose
   * @param depth - Maximum decomposition depth
   * @returns Task decomposition result
   */
  public async decomposeTask(task: string, depth = 3): Promise<TaskDecomposition> {
    this.logger?.debug?.('Decomposing task', { task, depth });

    const prompt = PLANNING_PROMPTS.decomposeTask.replace('{task}', task);
    const response = await this.callLLM(prompt, { jsonMode: true });
    const data = JSON.parse(response);

    const subtasks: SubTask[] = data.subtasks.map((st: Record<string, unknown>, idx: number) => ({
      subtaskId: `subtask-${idx}-${uuidv4().slice(0, 8)}`,
      description: st.description as string,
      complexity: st.complexity as number,
      dependsOn: (st.dependsOn as string[]) ?? [],
      estimatedTokens: (st.estimatedTokens as number) ?? 500,
      parallelizable: (st.parallelizable as boolean) ?? false,
    }));

    return {
      originalTask: task,
      subtasks,
      reasoning: data.reasoning,
      isComplete: true,
      executionOrder: data.executionOrder ?? subtasks.map((st) => st.subtaskId),
    };
  }

  /**
   * Validates a plan for feasibility and completeness.
   *
   * @param plan - Plan to validate
   * @returns Validation result with any issues found
   */
  public async validatePlan(plan: ExecutionPlan): Promise<PlanValidationResult> {
    const issues: PlanValidationIssue[] = [];
    const suggestions: string[] = [];

    // Check for empty plan
    if (plan.steps.length === 0) {
      issues.push({
        severity: 'error',
        message: 'Plan has no steps',
        suggestedFix: 'Regenerate plan with clearer goal',
      });
    }

    // Check for circular dependencies
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (stepId: string): boolean => {
      if (recursionStack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      recursionStack.add(stepId);

      const deps = plan.dependencies.get(stepId) ?? [];
      for (const dep of deps) {
        if (hasCycle(dep)) return true;
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of plan.steps) {
      if (hasCycle(step.stepId)) {
        issues.push({
          severity: 'error',
          stepId: step.stepId,
          message: 'Circular dependency detected',
          suggestedFix: 'Remove or restructure dependent steps',
        });
        break;
      }
    }

    // Check confidence scores
    const lowConfidenceSteps = plan.steps.filter((s) => s.confidence < 0.5);
    if (lowConfidenceSteps.length > 0) {
      issues.push({
        severity: 'warning',
        message: `${lowConfidenceSteps.length} steps have low confidence (<0.5)`,
        suggestedFix: 'Consider adding validation steps or gathering more context',
      });
    }

    // Check for missing tool references
    for (const step of plan.steps) {
      if (step.action.type === 'tool_call' && !step.action.toolId) {
        issues.push({
          severity: 'error',
          stepId: step.stepId,
          message: 'Tool call step missing toolId',
          suggestedFix: 'Specify the tool to be called',
        });
      }
    }

    // Suggestions
    if (plan.steps.length > 10) {
      suggestions.push('Consider breaking this plan into phases for better manageability');
    }
    if (plan.confidenceScore < 0.7) {
      suggestions.push('Overall confidence is moderate - consider adding validation checkpoints');
    }

    return {
      isValid: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
      suggestions,
    };
  }

  // ==========================================================================
  // Plan Refinement
  // ==========================================================================

  /**
   * Refines an existing plan based on execution feedback.
   *
   * @param plan - Original plan to refine
   * @param feedback - Feedback from execution
   * @returns Refined execution plan
   */
  public async refinePlan(
    plan: ExecutionPlan,
    feedback: ExecutionFeedback,
  ): Promise<ExecutionPlan> {
    this.logger?.info?.('Refining plan based on feedback', {
      planId: plan.planId,
      feedbackType: feedback.feedbackType,
    });

    // Get current execution state
    const state = this.executionStates.get(plan.planId);

    // Perform reflection
    const reflection = await this.reflect(plan, state ?? this.createInitialState(plan));

    // Apply adjustments based on reflection
    let refinedPlan = { ...plan };

    for (const adjustment of reflection.adjustments) {
      refinedPlan = this.applyAdjustment(refinedPlan, adjustment);
    }

    // Update confidence
    refinedPlan.confidenceScore = Math.max(
      0.1,
      Math.min(1.0, refinedPlan.confidenceScore + reflection.confidenceAdjustment),
    );

    // Update metadata
    refinedPlan.metadata.iterations++;

    this.logger?.info?.('Plan refined', {
      planId: refinedPlan.planId,
      adjustments: reflection.adjustments.length,
      newConfidence: refinedPlan.confidenceScore,
    });

    return refinedPlan;
  }

  /**
   * Performs self-reflection on plan execution state.
   *
   * @param plan - Current plan
   * @param executionState - Current execution state
   * @returns Reflection insights and suggested adjustments
   */
  public async reflect(
    plan: ExecutionPlan,
    executionState: ExecutionState,
  ): Promise<ReflectionResult> {
    const completedSteps = plan.steps.filter((s) =>
      executionState.completedSteps.includes(s.stepId),
    );

    const failedSteps = plan.steps.filter((s) => executionState.failedSteps.includes(s.stepId));

    const resultsStr = Array.from(executionState.results.entries())
      .map(([id, result]) => `${id}: ${result.success ? 'Success' : 'Failed'} - ${JSON.stringify(result.output)}`)
      .join('\n');

    const prompt = PLANNING_PROMPTS.reflect
      .replace('{goal}', plan.goal)
      .replace('{plan}', JSON.stringify(plan.steps.map((s) => s.action)))
      .replace('{completedSteps}', completedSteps.map((s) => s.stepId).join(', '))
      .replace('{results}', resultsStr)
      .replace('{issues}', failedSteps.map((s) => `Step ${s.stepId} failed`).join(', '));

    const response = await this.callLLM(prompt, { jsonMode: true });
    const data = JSON.parse(response);

    return {
      insights: data.insights ?? [],
      issues: data.issues ?? [],
      adjustments: (data.adjustments ?? []).map((adj: Record<string, unknown>) => ({
        type: adj.type as PlanAdjustment['type'],
        targetStepId: adj.targetStepId as string | undefined,
        reason: adj.reason as string,
      })),
      confidenceAdjustment: data.confidenceAdjustment ?? 0,
      recommendation: data.recommendation ?? 'continue',
    };
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  /**
   * Executes a single plan step.
   *
   * @param step - Step to execute
   * @param context - Execution context
   * @returns Step execution result
   */
  public async executeStep(
    step: PlanStep,
    context?: StepExecutionContext,
  ): Promise<PlanStepResult> {
    const startTime = Date.now();
    this.logger?.debug?.('Executing step', { stepId: step.stepId, action: step.action.type });

    try {
      let output: unknown;
      const tokensUsed = 0;
      const observations: string[] = [];

      switch (step.action.type) {
        case 'tool_call':
          if (step.action.toolId && context?.tools) {
            const tool = context.tools.find((t) => t.id === step.action.toolId);
            if (tool) {
              const toolResult = await tool.execute(step.action.toolArgs ?? {}, {
                gmiId: 'planning-engine',
                personaId: 'planner',
                userContext: { userId: 'system' },
              });
              output = toolResult.output;
              observations.push(`Tool ${tool.name} executed: ${toolResult.success ? 'success' : 'failed'}`);
            } else {
              throw new Error(`Tool ${step.action.toolId} not found`);
            }
          }
          break;

        case 'reasoning': {
          const reasoningPrompt = `Reason through: ${step.action.content}\n\nPrevious context: ${JSON.stringify(context?.previousResults)}`;
          output = await this.callLLM(reasoningPrompt);
          observations.push('Reasoning step completed');
          break;
        }

        case 'information_gathering':
          if (context?.retrieve && step.action.query) {
            const retrieved = await context.retrieve(step.action.query);
            output = retrieved;
            observations.push(`Retrieved ${retrieved.length} relevant items`);
          }
          break;

        case 'synthesis': {
          const synthesisPrompt = `Synthesize the following results into a coherent output:\n${JSON.stringify(context?.previousResults)}\n\nContext: ${step.action.content}`;
          output = await this.callLLM(synthesisPrompt);
          observations.push('Synthesis completed');
          break;
        }

        case 'validation': {
          const validationPrompt = `Validate the following output against expected criteria:\nOutput: ${JSON.stringify(context?.previousResults)}\nCriteria: ${step.action.content}`;
          output = await this.callLLM(validationPrompt, { jsonMode: true });
          observations.push('Validation completed');
          break;
        }

        default:
          output = { message: 'Step type not implemented', type: step.action.type };
      }

      return {
        success: true,
        output,
        tokensUsed,
        durationMs: Date.now() - startTime,
        observations,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Step execution failed', { stepId: step.stepId, error: errorMessage });
      return {
        success: false,
        output: null,
        error: errorMessage,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        observations: [`Error: ${errorMessage}`],
      };
    }
  }

  /**
   * Runs an autonomous goal pursuit loop.
   *
   * @param goal - Goal to pursue
   * @param options - Loop configuration
   * @yields Progress updates
   * @returns Final execution summary
   */
  public async *runAutonomousLoop(
    goal: string,
    options?: AutonomousLoopOptions,
  ): AsyncGenerator<LoopProgress, ExecutionSummary, undefined> {
    const opts: Required<AutonomousLoopOptions> = {
      maxIterations: options?.maxIterations ?? 20,
      goalConfidenceThreshold: options?.goalConfidenceThreshold ?? 0.9,
      enableReflection: options?.enableReflection ?? true,
      reflectionFrequency: options?.reflectionFrequency ?? 3,
      requireApprovalFor: options?.requireApprovalFor ?? ['human_input'],
      onProgress: options?.onProgress ?? (() => {}),
      onApprovalRequired: options?.onApprovalRequired ?? (async () => true),
    };

    const startTime = Date.now();
    let tokensUsed = 0;
    const allObservations: string[] = [];
    let iteration = 0;
    let goalConfidence = 0;
    let currentPlan: ExecutionPlan | null = null;

    this.logger?.info?.('Starting autonomous loop', { goal, maxIterations: opts.maxIterations });

    try {
      // Generate initial plan
      currentPlan = await this.generatePlan(goal, {}, { strategy: 'react' });
      const state = this.createInitialState(currentPlan);
      this.executionStates.set(currentPlan.planId, state);

      while (iteration < opts.maxIterations && goalConfidence < opts.goalConfidenceThreshold) {
        iteration++;

        // Get next ready step
        const nextStep = this.getNextReadyStep(currentPlan, state);
        if (!nextStep) {
          // All steps complete or blocked
          goalConfidence = currentPlan.confidenceScore;
          break;
        }

        // Check if approval required
        if (opts.requireApprovalFor.includes(nextStep.action.type)) {
          const approved = await opts.onApprovalRequired({
            requestId: uuidv4(),
            step: nextStep,
            reason: `Action type ${nextStep.action.type} requires approval`,
            suggestedAction: 'approve',
            timeoutMs: 30000,
          });
          if (!approved) {
            state.failedSteps.push(nextStep.stepId);
            continue;
          }
        }

        // Execute step
        const result = await this.executeStep(nextStep, {
          previousResults: state.results,
          tools: [],
        });

        // Update state
        state.results.set(nextStep.stepId, result);
        if (result.success) {
          state.completedSteps.push(nextStep.stepId);
        } else {
          state.failedSteps.push(nextStep.stepId);
        }
        state.tokensUsed += result.tokensUsed;
        tokensUsed += result.tokensUsed;
        allObservations.push(...result.observations);
        state.lastUpdatedAt = new Date();

        // Calculate progress
        const progress = state.completedSteps.length / currentPlan.steps.length;
        goalConfidence = progress * currentPlan.confidenceScore;

        // Yield progress
        const loopProgress: LoopProgress = {
          iteration,
          currentStep: nextStep,
          progress,
          observations: allObservations,
          goalConfidence,
          tokensUsed,
        };
        opts.onProgress(loopProgress);
        yield loopProgress;

        // Reflection at intervals
        if (opts.enableReflection && iteration % opts.reflectionFrequency === 0) {
          const reflection = await this.reflect(currentPlan, state);
          if (reflection.recommendation === 'replan') {
            currentPlan = await this.generatePlan(goal, {
              failedApproaches: state.failedSteps.map((id) => `Step ${id} failed`),
            });
            state.currentStepIndex = 0;
          } else if (reflection.recommendation === 'abort') {
            break;
          }
        }
      }

      // Generate final summary
      const summary: ExecutionSummary = {
        goalAchieved: goalConfidence >= opts.goalConfidenceThreshold,
        finalConfidence: goalConfidence,
        iterations: iteration,
        totalTokensUsed: tokensUsed,
        totalDurationMs: Date.now() - startTime,
        outcomes: allObservations.slice(-10),
        unresolvedIssues: state.failedSteps.map((id) => `Step ${id} failed`),
      };

      this.logger?.info?.('Autonomous loop completed', summary);
      return summary;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Autonomous loop failed', { goal, error: errorMessage });
      return {
        goalAchieved: false,
        finalConfidence: 0,
        iterations: iteration,
        totalTokensUsed: tokensUsed,
        totalDurationMs: Date.now() - startTime,
        outcomes: [],
        unresolvedIssues: [errorMessage],
      };
    }
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Saves current execution state for checkpointing.
   *
   * @param plan - Plan being executed
   * @param state - Current execution state
   * @returns Checkpoint identifier
   */
  public async saveCheckpoint(plan: ExecutionPlan, state: ExecutionState): Promise<string> {
    const checkpointId = `checkpoint-${plan.planId}-${Date.now()}`;
    this.checkpoints.set(checkpointId, {
      plan: JSON.parse(JSON.stringify(plan)),
      state: {
        ...state,
        results: new Map(state.results),
      },
    });
    this.logger?.debug?.('Checkpoint saved', { checkpointId, planId: plan.planId });
    return checkpointId;
  }

  /**
   * Restores execution state from a checkpoint.
   *
   * @param checkpointId - Checkpoint to restore
   * @returns Restored plan and state
   */
  public async restoreCheckpoint(
    checkpointId: string,
  ): Promise<{ plan: ExecutionPlan; state: ExecutionState }> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }
    this.logger?.debug?.('Checkpoint restored', { checkpointId });
    return {
      plan: JSON.parse(JSON.stringify(checkpoint.plan)),
      state: {
        ...checkpoint.state,
        results: new Map(checkpoint.state.results),
      },
    };
  }

  /**
   * Gets the current execution state for a plan.
   *
   * @param planId - Plan identifier
   * @returns Current execution state or null
   */
  public getExecutionState(planId: string): ExecutionState | null {
    return this.executionStates.get(planId) ?? null;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private buildPlanningPrompt(
    goal: string,
    context: PlanningContext | undefined,
    options: PlanningOptions,
  ): string {
    const toolsStr = options.availableTools
      ? options.availableTools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
      : 'No tools available';

    const contextStr = [
      context?.conversationHistory && `Conversation: ${context.conversationHistory}`,
      context?.retrievedContext && `Retrieved Context: ${context.retrievedContext}`,
      context?.domainContext && `Domain: ${context.domainContext}`,
      context?.userConstraints?.length && `Constraints: ${context.userConstraints.join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n');

    return PLANNING_PROMPTS.generatePlan
      .replace('{goal}', goal)
      .replace('{context}', contextStr || 'No additional context')
      .replace('{tools}', toolsStr)
      .replace('{maxSteps}', String(options.maxSteps))
      .replace('{strategy}', options.strategy ?? 'react')
      .replace('{additionalConstraints}', options.allowToolUse ? 'Tool use is allowed' : 'No tool use');
  }

  private buildExecutionPlan(
    goal: string,
    planData: Record<string, unknown>,
    options: PlanningOptions,
    startTime: number,
  ): ExecutionPlan {
    const planId = `plan-${uuidv4()}`;
    const steps: PlanStep[] = [];
    const dependencies = new Map<string, string[]>();

    const rawSteps = planData.steps as Array<Record<string, unknown>>;
    let totalEstimatedTokens = 0;

    for (let i = 0; i < rawSteps.length; i++) {
      const rawStep = rawSteps[i];
      const stepId = `step-${i}-${uuidv4().slice(0, 8)}`;
      const action = rawStep.action as Record<string, unknown>;

      const step: PlanStep = {
        stepId,
        index: i,
        action: {
          type: (action.type as PlanActionType) ?? 'reasoning',
          toolId: action.toolId as string | undefined,
          toolArgs: action.toolArgs as Record<string, unknown> | undefined,
          content: (action.content as string) ?? '',
        },
        reasoning: (rawStep.reasoning as string) ?? '',
        expectedOutcome: (rawStep.expectedOutcome as string) ?? '',
        dependsOn: (rawStep.dependsOn as string[]) ?? [],
        estimatedTokens: (rawStep.estimatedTokens as number) ?? 500,
        confidence: (rawStep.confidence as number) ?? 0.7,
        requiresHumanApproval: action.type === 'human_input',
        status: 'pending',
      };

      steps.push(step);
      dependencies.set(stepId, step.dependsOn);
      totalEstimatedTokens += step.estimatedTokens;
    }

    return {
      planId,
      goal,
      steps,
      dependencies,
      estimatedTokens: totalEstimatedTokens,
      confidenceScore: (planData.overallConfidence as number) ?? 0.7,
      createdAt: new Date(),
      strategy: options.strategy ?? 'react',
      metadata: {
        modelId: this.defaultModelId,
        iterations: 1,
        planningDurationMs: Date.now() - startTime,
        alternativesConsidered: 1,
      },
    };
  }

  private createInitialState(plan: ExecutionPlan): ExecutionState {
    return {
      planId: plan.planId,
      currentStepIndex: 0,
      completedSteps: [],
      failedSteps: [],
      results: new Map(),
      tokensUsed: 0,
      startedAt: new Date(),
      lastUpdatedAt: new Date(),
    };
  }

  private getNextReadyStep(plan: ExecutionPlan, state: ExecutionState): PlanStep | null {
    for (const step of plan.steps) {
      if (state.completedSteps.includes(step.stepId)) continue;
      if (state.failedSteps.includes(step.stepId)) continue;

      // Check if dependencies are met
      const depsmet = step.dependsOn.every((depId) => state.completedSteps.includes(depId));
      if (depsmet) {
        return step;
      }
    }
    return null;
  }

  private applyAdjustment(plan: ExecutionPlan, adjustment: PlanAdjustment): ExecutionPlan {
    const newPlan = { ...plan, steps: [...plan.steps] };

    switch (adjustment.type) {
      case 'remove_step':
        if (adjustment.targetStepId) {
          newPlan.steps = newPlan.steps.filter((s) => s.stepId !== adjustment.targetStepId);
        }
        break;
      case 'modify_step':
        if (adjustment.targetStepId && adjustment.newStepData) {
          const idx = newPlan.steps.findIndex((s) => s.stepId === adjustment.targetStepId);
          if (idx >= 0) {
            newPlan.steps[idx] = { ...newPlan.steps[idx], ...adjustment.newStepData };
          }
        }
        break;
      // Add other adjustment types as needed
    }

    return newPlan;
  }

  private async callLLM(prompt: string, options?: { jsonMode?: boolean }): Promise<string> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const providerId = this.defaultProviderId ?? 'openai';

    const provider = this.llmProvider.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" not found`);
    }

    const response = await provider.generateCompletion(
      this.defaultModelId,
      messages,
      {
        temperature: 0.7,
        maxTokens: 4000,
        responseFormat: options?.jsonMode ? { type: 'json_object' } : undefined,
      },
    );

    const content = response.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }
}

