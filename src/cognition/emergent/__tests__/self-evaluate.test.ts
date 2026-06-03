/**
 * @fileoverview Tests for SelfEvaluateTool.
 *
 * Covers:
 *  1. Evaluate a response and receive scores
 *  2. Store evaluation as memory trace when storeMemory is provided
 *  3. Enforce maxEvaluationsPerSession limit
 *  4. Adjust a non-personality parameter (temperature)
 *  5. Delegate personality adjustment to AdaptPersonalityTool
 *  6. Generate a report with averages and adjustments
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfEvaluateTool, type SelfEvaluateDeps } from '../SelfEvaluateTool.js';
import { AdaptPersonalityTool } from '../AdaptPersonalityTool.js';
import type { ToolExecutionContext } from '../../../core/tools/ITool.js';
import { generateText } from '../../../api/generateText.js';

// ---------------------------------------------------------------------------
// Mock generateText
// ---------------------------------------------------------------------------

vi.mock('../../../api/generateText.js', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      relevance: 0.9,
      clarity: 0.85,
      accuracy: 0.95,
      helpfulness: 0.8,
    }),
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    finishReason: 'stop',
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ToolExecutionContext for testing. */
function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    gmiId: 'test-gmi',
    personaId: 'test-persona',
    userContext: { userId: 'test-user' } as any,
    correlationId: 'test-session',
    ...overrides,
  };
}

/** Build default deps with sensible defaults. */
function makeDeps(overrides?: Partial<SelfEvaluateDeps>): SelfEvaluateDeps {
  return {
    config: {
      autoAdjust: false,
      adjustableParams: ['temperature', 'verbosity', 'openness'],
      maxEvaluationsPerSession: 5,
      evaluationModel: undefined,
    },
    ...overrides,
  };
}

/** Build a minimal AdaptPersonalityTool for delegation tests. */
function makeAdaptPersonalityTool(): AdaptPersonalityTool {
  const personality: Record<string, number> = {
    openness: 0.5,
    conscientiousness: 0.5,
    emotionality: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    honesty: 0.5,
  };

  return new AdaptPersonalityTool({
    config: { maxDeltaPerSession: 0.3 },
    mutationStore: { record: vi.fn().mockResolvedValue('pm_test') },
    getPersonality: () => personality,
    setPersonality: (trait, value) => {
      personality[trait] = value;
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SelfEvaluateTool', () => {
  const ctx = makeContext();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should evaluate a response and return scores', async () => {
    const tool = new SelfEvaluateTool(makeDeps());

    const result = await tool.execute(
      {
        action: 'evaluate',
        response: 'The capital of France is Paris.',
        query: 'What is the capital of France?',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output.scores).toBeDefined();
    expect(result.output.scores.relevance).toBe(0.9);
    expect(result.output.scores.clarity).toBe(0.85);
    expect(result.output.scores.accuracy).toBe(0.95);
    expect(result.output.scores.helpfulness).toBe(0.8);
    expect(result.output.evalCount).toBe(1);
    expect(result.output.remainingEvaluations).toBe(4);
  });

  it('should use the configured evaluation model override', async () => {
    const tool = new SelfEvaluateTool(
      makeDeps({
        config: {
          autoAdjust: false,
          adjustableParams: ['temperature'],
          maxEvaluationsPerSession: 5,
          evaluationModel: 'claude-code-cli:claude-haiku-4-5-20251001',
        },
      }),
    );

    await tool.execute(
      {
        action: 'evaluate',
        response: 'The capital of France is Paris.',
        query: 'What is the capital of France?',
      },
      ctx,
    );

    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-code-cli:claude-haiku-4-5-20251001',
      }),
    );
  });

  it('should store evaluation as memory trace when storeMemory is provided', async () => {
    const storeMemory = vi.fn().mockResolvedValue(undefined);
    const tool = new SelfEvaluateTool(makeDeps({ storeMemory }));

    await tool.execute(
      {
        action: 'evaluate',
        response: 'Paris is the capital.',
        query: 'Capital of France?',
      },
      ctx,
    );

    expect(storeMemory).toHaveBeenCalledOnce();
    expect(storeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'self-evaluation',
        scope: 'session',
        tags: ['evaluation', 'quality'],
      }),
    );
  });

  it('should enforce maxEvaluationsPerSession limit', async () => {
    const tool = new SelfEvaluateTool(
      makeDeps({ config: { autoAdjust: false, adjustableParams: [], maxEvaluationsPerSession: 2 } }),
    );
    const sessionOneCallOne = makeContext({
      correlationId: 'call-1',
      sessionData: { sessionId: 'session-one' },
    });
    const sessionOneCallTwo = makeContext({
      correlationId: 'call-2',
      sessionData: { sessionId: 'session-one' },
    });
    const sessionOneCallThree = makeContext({
      correlationId: 'call-3',
      sessionData: { sessionId: 'session-one' },
    });
    const sessionTwoCallOne = makeContext({
      correlationId: 'call-1',
      sessionData: { sessionId: 'session-two' },
    });

    // First two should succeed
    await tool.execute({ action: 'evaluate', response: 'r1', query: 'q1' }, sessionOneCallOne);
    await tool.execute({ action: 'evaluate', response: 'r2', query: 'q2' }, sessionOneCallTwo);

    // Third should fail
    const result = await tool.execute(
      { action: 'evaluate', response: 'r3', query: 'q3' },
      sessionOneCallThree,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum evaluations');

    const otherSession = await tool.execute(
      { action: 'evaluate', response: 'r4', query: 'q4' },
      sessionTwoCallOne,
    );

    expect(otherSession.success).toBe(true);
    expect(otherSession.output.evalCount).toBe(1);
  });

  it('should adjust a non-personality parameter', async () => {
    const tool = new SelfEvaluateTool(makeDeps());

    const result = await tool.execute(
      { action: 'adjust', param: 'temperature', value: 0.7 },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output.param).toBe('temperature');
    expect(result.output.newValue).toBe(0.7);
    expect(result.output.previousValue).toBeNull();
  });

  it('should delegate personality adjustment to AdaptPersonalityTool', async () => {
    const adaptTool = makeAdaptPersonalityTool();
    const tool = new SelfEvaluateTool(makeDeps({ adaptPersonality: adaptTool }));

    const result = await tool.execute(
      {
        action: 'adjust',
        param: 'openness',
        value: 0.1,
        reasoning: 'User wants more creative answers.',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.trait).toBe('openness');
    expect(result.output!.previousValue).toBe(0.5);
    expect(result.output!.newValue).toBeCloseTo(0.6);
  });

  it('should allow trait adjustments when generic personality is configured', async () => {
    const adaptTool = makeAdaptPersonalityTool();
    const tool = new SelfEvaluateTool(
      makeDeps({
        config: {
          autoAdjust: false,
          adjustableParams: ['personality'],
          maxEvaluationsPerSession: 5,
          evaluationModel: undefined,
        },
        adaptPersonality: adaptTool,
      }),
    );

    const result = await tool.execute(
      {
        action: 'adjust',
        param: 'openness',
        value: 0.1,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.trait).toBe('openness');
  });

  it('should support param=personality with a trait payload', async () => {
    const adaptTool = makeAdaptPersonalityTool();
    const tool = new SelfEvaluateTool(
      makeDeps({
        config: {
          autoAdjust: false,
          adjustableParams: ['personality'],
          maxEvaluationsPerSession: 5,
          evaluationModel: undefined,
        },
        adaptPersonality: adaptTool,
      }),
    );

    const result = await tool.execute(
      {
        action: 'adjust',
        param: 'personality',
        value: { trait: 'openness', delta: 0.1 },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output!.trait).toBe('openness');
    expect(result.output!.newValue).toBeCloseTo(0.6);
  });

  it('should generate a report with averages and adjustments', async () => {
    const tool = new SelfEvaluateTool(makeDeps());

    // Perform two evaluations
    await tool.execute({ action: 'evaluate', response: 'r1', query: 'q1' }, ctx);
    await tool.execute({ action: 'evaluate', response: 'r2', query: 'q2' }, ctx);

    // Adjust a parameter
    await tool.execute({ action: 'adjust', param: 'temperature', value: 0.3 }, ctx);

    // Generate report
    const result = await tool.execute({ action: 'report' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output.totalEvaluations).toBe(2);
    expect(result.output.averageScores.relevance).toBeCloseTo(0.9);
    expect(result.output.averageScores.clarity).toBeCloseTo(0.85);
    expect(result.output.adjustments).toHaveLength(1);
    expect(result.output.adjustments[0].param).toBe('temperature');
  });

  it('should auto-apply evaluator suggested adjustments when enabled', async () => {
    const adaptTool = makeAdaptPersonalityTool();
    const generateTextImpl = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        relevance: 0.6,
        clarity: 0.55,
        accuracy: 0.9,
        helpfulness: 0.5,
        adjustments: [
          {
            param: 'temperature',
            value: 0.2,
            reasoning: 'Lower temperature for more precise answers.',
          },
          {
            param: 'personality',
            value: { trait: 'openness', delta: 0.1 },
            reasoning: 'Increase creativity slightly.',
          },
        ],
      }),
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const tool = new SelfEvaluateTool(
      makeDeps({
        config: {
          autoAdjust: true,
          adjustableParams: ['temperature', 'personality'],
          maxEvaluationsPerSession: 5,
          evaluationModel: undefined,
        },
        adaptPersonality: adaptTool,
        generateTextImpl,
      }),
    );

    const result = await tool.execute(
      {
        action: 'evaluate',
        response: 'Paris is the capital of France.',
        query: 'What is the capital of France?',
      },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'session-one' },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.output.appliedAdjustments).toHaveLength(2);
    expect(result.output.appliedAdjustments[0].param).toBe('temperature');
    expect(result.output.appliedAdjustments[1].param).toBe('personality');

    const report = await tool.execute(
      { action: 'report' },
      makeContext({
        correlationId: 'call-2',
        sessionData: { sessionId: 'session-one' },
      }),
    );

    expect(report.success).toBe(true);
    expect(report.output.adjustments).toHaveLength(1);
    expect(report.output.adjustments[0].param).toBe('temperature');
    expect(report.output.personalityDrift.openness.totalDelta).toBeCloseTo(0.1);
  });

  it('should scope reports and parameter state to the active session', async () => {
    const tool = new SelfEvaluateTool(makeDeps());

    await tool.execute(
      { action: 'evaluate', response: 'r1', query: 'q1' },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'session-one' },
      }),
    );
    await tool.execute(
      { action: 'adjust', param: 'temperature', value: 0.3 },
      makeContext({
        correlationId: 'call-2',
        sessionData: { sessionId: 'session-one' },
      }),
    );

    const otherSessionAdjust = await tool.execute(
      { action: 'adjust', param: 'temperature', value: 0.7 },
      makeContext({
        correlationId: 'call-1',
        sessionData: { sessionId: 'session-two' },
      }),
    );

    expect(otherSessionAdjust.success).toBe(true);
    expect(otherSessionAdjust.output.previousValue).toBeNull();

    const report = await tool.execute(
      { action: 'report' },
      makeContext({
        correlationId: 'call-2',
        sessionData: { sessionId: 'session-two' },
      }),
    );

    expect(report.success).toBe(true);
    expect(report.output.totalEvaluations).toBe(0);
    expect(report.output.adjustments).toHaveLength(1);
    expect(report.output.adjustments[0].new).toBe(0.7);
  });

  it('should use host session param hooks for non-personality adjustments', async () => {
    const runtimeParams = new Map<string, unknown>();
    const tool = new SelfEvaluateTool(
      makeDeps({
        getSessionParam: (param, _context) => runtimeParams.get(param),
        setSessionParam: (param, value, _context) => {
          runtimeParams.set(param, value);
        },
      }),
    );

    const first = await tool.execute(
      { action: 'adjust', param: 'temperature', value: 0.4 },
      ctx,
    );
    const second = await tool.execute(
      { action: 'adjust', param: 'temperature', value: 0.6 },
      ctx,
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(runtimeParams.get('temperature')).toBe(0.6);
    expect(second.output.previousValue).toBe(0.4);
  });
});
