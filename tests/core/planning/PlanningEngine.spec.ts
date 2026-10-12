/**
 * @file PlanningEngine.spec.ts
 * @description Unit tests for the AgentOS Planning Engine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanningEngine, type PlanningEngineConfig } from '../../../src/orchestration/planner/PlanningEngine';
import type { AIModelProviderManager } from '../../../src/core/llm/providers/AIModelProviderManager';
import type { ExecutionPlan, PlanStep } from '../../../src/orchestration/planner/IPlanningEngine';

// Mock generate completion function
let mockGenerateCompletion: ReturnType<typeof vi.fn>;

// Mock LLM Provider Manager
const createMockLLMProvider = (): AIModelProviderManager => {
  const mockResponse = {
    choices: [{
      message: {
        content: JSON.stringify({
          reasoning: 'Test reasoning',
          steps: [
            {
              action: { type: 'reasoning', content: 'Step 1: Analyze the problem' },
              reasoning: 'First we need to understand the problem',
              expectedOutcome: 'Clear understanding of requirements',
              dependsOn: [],
              estimatedTokens: 500,
              confidence: 0.85,
            },
            {
              action: { type: 'tool_call', toolId: 'search', toolArgs: { query: 'test' } },
              reasoning: 'Need to gather information',
              expectedOutcome: 'Relevant information gathered',
              dependsOn: ['step-0'],
              estimatedTokens: 300,
              confidence: 0.8,
            },
            {
              action: { type: 'synthesis', content: 'Combine results' },
              reasoning: 'Need to synthesize findings',
              expectedOutcome: 'Coherent summary',
              dependsOn: ['step-1'],
              estimatedTokens: 400,
              confidence: 0.9,
            },
          ],
          overallConfidence: 0.85,
        }),
      },
    }],
  };
  mockGenerateCompletion = vi.fn().mockResolvedValue(mockResponse);
  const mockProvider = {
    generateCompletion: mockGenerateCompletion,
  };
  return {
    getProvider: vi.fn().mockReturnValue(mockProvider),
  } as unknown as AIModelProviderManager;
};

// Helper to create mock response with custom content
const createMockResponse = (content: string) => ({
  choices: [{ message: { content } }],
});

describe('PlanningEngine', () => {
  let engine: PlanningEngine;
  let mockLLMProvider: AIModelProviderManager;

  beforeEach(() => {
    mockLLMProvider = createMockLLMProvider();
    engine = new PlanningEngine({
      llmProvider: mockLLMProvider,
      defaultModelId: 'gpt-4-test',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs goal and task lengths without words, including failed planning and loops', async () => {
    const sentinel = 'sentinel-words-7731';
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const planning = new PlanningEngine({ llmProvider: mockLLMProvider, logger: logger as any });
    await planning.generatePlan(sentinel);
    mockGenerateCompletion.mockResolvedValueOnce(createMockResponse(JSON.stringify({ subtasks: [] })));
    await planning.decomposeTask(sentinel);
    mockGenerateCompletion.mockResolvedValue(createMockResponse(sentinel));
    await expect(planning.generatePlan(sentinel)).rejects.toThrow();
    const loop = planning.runAutonomousLoop(sentinel);
    const end = await loop.next();
    expect(end.done).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('Generating execution plan', { goalLength: sentinel.length, strategy: expect.any(String) });
    expect(logger.debug).toHaveBeenCalledWith('Decomposing task', { taskLength: sentinel.length, depth: 3 });
    expect(logger.info).toHaveBeenCalledWith('Starting autonomous loop', { goalLength: sentinel.length, maxIterations: 20 });
    for (const message of ['Failed to generate plan', 'Autonomous loop failed']) {
      expect(logger.error).toHaveBeenCalledWith(message, { goalLength: sentinel.length, error: 'Planning operation failed.' });
    }
    expect(JSON.stringify(Object.values(logger).map((spy) => spy.mock.calls))).not.toContain(sentinel);
  });

  describe('generatePlan', () => {
    it('should generate a valid execution plan', async () => {
      const plan = await engine.generatePlan('Test goal', {}, { maxSteps: 10 });

      expect(plan).toBeDefined();
      expect(plan.planId).toMatch(/^plan-/);
      expect(plan.goal).toBe('Test goal');
      expect(plan.steps).toHaveLength(3);
      expect(plan.confidenceScore).toBe(0.85);
    });

    it('should assign unique step IDs', async () => {
      const plan = await engine.generatePlan('Test goal');

      const stepIds = plan.steps.map((s) => s.stepId);
      const uniqueIds = new Set(stepIds);
      expect(uniqueIds.size).toBe(stepIds.length);
    });

    it('should build dependency graph correctly', async () => {
      const plan = await engine.generatePlan('Test goal');

      expect(plan.dependencies).toBeInstanceOf(Map);
      expect(plan.dependencies.size).toBe(3);
    });

    it('should use specified planning strategy', async () => {
      const plan = await engine.generatePlan('Test goal', {}, { strategy: 'tree_of_thought' });

      expect(plan.strategy).toBe('tree_of_thought');
    });

    it('should include metadata about planning', async () => {
      const plan = await engine.generatePlan('Test goal');

      expect(plan.metadata).toBeDefined();
      expect(plan.metadata.modelId).toBe('gpt-4-test');
      expect(plan.metadata.iterations).toBe(1);
      expect(plan.metadata.planningDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('validatePlan', () => {
    it('should validate a correct plan', async () => {
      const plan = await engine.generatePlan('Test goal');
      const validation = await engine.validatePlan(plan);

      expect(validation.isValid).toBe(true);
    });

    it('should detect empty plans', async () => {
      const emptyPlan: ExecutionPlan = {
        planId: 'test-plan',
        goal: 'Test',
        steps: [],
        dependencies: new Map(),
        estimatedTokens: 0,
        confidenceScore: 0.5,
        createdAt: new Date(),
        strategy: 'react',
        metadata: {
          modelId: 'test',
          iterations: 1,
          planningDurationMs: 0,
          alternativesConsidered: 0,
        },
      };

      const validation = await engine.validatePlan(emptyPlan);
      expect(validation.isValid).toBe(false);
      expect(validation.issues.some((i) => i.message.includes('no steps'))).toBe(true);
    });

    it('should detect tool_call steps without toolId', async () => {
      const plan = await engine.generatePlan('Test goal');
      // Modify a step to have missing toolId
      const invalidStep = plan.steps.find((s) => s.action.type === 'tool_call');
      if (invalidStep) {
        invalidStep.action.toolId = undefined;
      }

      const validation = await engine.validatePlan(plan);
      expect(validation.issues.some((i) => i.message.includes('toolId'))).toBe(true);
    });

    it('should warn about low confidence steps', async () => {
      const plan = await engine.generatePlan('Test goal');
      // Set all confidence to low
      plan.steps.forEach((s) => {
        s.confidence = 0.3;
      });

      const validation = await engine.validatePlan(plan);
      expect(validation.issues.some((i) => i.message.includes('low confidence'))).toBe(true);
    });
  });

  describe('decomposeTask', () => {
    beforeEach(() => {
      mockGenerateCompletion.mockResolvedValueOnce(createMockResponse(JSON.stringify({
        reasoning: 'Breaking down the task',
        subtasks: [
          { description: 'Subtask 1', complexity: 3, dependsOn: [], parallelizable: true },
          { description: 'Subtask 2', complexity: 5, dependsOn: [], parallelizable: false },
          { description: 'Subtask 3', complexity: 2, dependsOn: ['subtask-0'], parallelizable: true },
        ],
        executionOrder: ['subtask-0', 'subtask-1', 'subtask-2'],
      })));
    });

    it('should decompose a complex task into subtasks', async () => {
      const decomposition = await engine.decomposeTask('Build a REST API');

      expect(decomposition.subtasks).toHaveLength(3);
      expect(decomposition.originalTask).toBe('Build a REST API');
      expect(decomposition.isComplete).toBe(true);
    });

    it('should assign unique subtask IDs', async () => {
      const decomposition = await engine.decomposeTask('Build a REST API');

      const ids = decomposition.subtasks.map((s) => s.subtaskId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should include complexity estimates', async () => {
      const decomposition = await engine.decomposeTask('Build a REST API');

      decomposition.subtasks.forEach((st) => {
        expect(st.complexity).toBeGreaterThanOrEqual(1);
        expect(st.complexity).toBeLessThanOrEqual(10);
      });
    });
  });

  describe('executeStep', () => {
    it('should execute a reasoning step', async () => {
      const step: PlanStep = {
        stepId: 'test-step',
        index: 0,
        action: { type: 'reasoning', content: 'Think about the problem' },
        reasoning: 'Need to reason',
        expectedOutcome: 'Understanding',
        dependsOn: [],
        estimatedTokens: 100,
        confidence: 0.9,
        requiresHumanApproval: false,
        status: 'ready',
      };

      mockGenerateCompletion.mockResolvedValueOnce(createMockResponse('Reasoning output'));

      const result = await engine.executeStep(step);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Reasoning output');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle step execution errors gracefully', async () => {
      const step: PlanStep = {
        stepId: 'test-step',
        index: 0,
        action: { type: 'tool_call', toolId: 'nonexistent-tool' },
        reasoning: 'Call tool',
        expectedOutcome: 'Tool output',
        dependsOn: [],
        estimatedTokens: 100,
        confidence: 0.9,
        requiresHumanApproval: false,
        status: 'ready',
      };

      const result = await engine.executeStep(step, { previousResults: new Map(), tools: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('refinePlan', () => {
    beforeEach(() => {
      // Mock reflection response
      mockGenerateCompletion
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({
          reasoning: 'Test',
          steps: [{ action: { type: 'reasoning' }, reasoning: 'r', expectedOutcome: 'e', confidence: 0.8 }],
          overallConfidence: 0.8,
        })))
        .mockResolvedValueOnce(createMockResponse(JSON.stringify({
          insights: ['Step failed due to API error'],
          issues: ['Retry needed'],
          adjustments: [{ type: 'modify_step', targetStepId: 'step-0', reason: 'Update retry logic' }],
          confidenceAdjustment: -0.1,
          recommendation: 'adjust',
        })));
    });

    it('should refine plan based on feedback', async () => {
      const originalPlan = await engine.generatePlan('Test goal');
      const refinedPlan = await engine.refinePlan(originalPlan, {
        planId: originalPlan.planId,
        stepId: originalPlan.steps[0].stepId,
        feedbackType: 'step_failed',
        details: 'API error',
        severity: 'error',
      });

      expect(refinedPlan.planId).toBe(originalPlan.planId);
      expect(refinedPlan.metadata.iterations).toBe(2);
    });
  });

  describe('checkpointing', () => {
    it('should save and restore checkpoints', async () => {
      const plan = await engine.generatePlan('Test goal');
      const state = {
        planId: plan.planId,
        currentStepIndex: 1,
        completedSteps: [plan.steps[0].stepId],
        failedSteps: [],
        results: new Map(),
        tokensUsed: 500,
        startedAt: new Date(),
        lastUpdatedAt: new Date(),
      };

      const checkpointId = await engine.saveCheckpoint(plan, state);
      expect(checkpointId).toMatch(/^checkpoint-/);

      const restored = await engine.restoreCheckpoint(checkpointId);
      expect(restored.plan.planId).toBe(plan.planId);
      expect(restored.state.currentStepIndex).toBe(1);
    });

    it('should throw error for unknown checkpoint', async () => {
      await expect(engine.restoreCheckpoint('unknown-checkpoint')).rejects.toThrow();
    });
  });

  describe('getExecutionState', () => {
    it('should return null for unknown plan', () => {
      const state = engine.getExecutionState('unknown-plan');
      expect(state).toBeNull();
    });
  });
});

