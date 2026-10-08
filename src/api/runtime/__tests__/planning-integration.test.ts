/**
 * @file planning-integration.test.ts
 * @description Tests for the plan-then-execute integration in generateText.
 *
 * Validates three behaviours:
 *   1. Planning disabled (default) — no planning call is made.
 *   2. Planning enabled (`planning: true`) — an upfront planning call is made,
 *      the plan is injected into the system prompt, and the tool loop proceeds.
 *   3. Planning with custom config — custom temperature, maxTokens, and system
 *      prompt are forwarded to the planning call.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup — mirrors the pattern used by generateText.test.ts
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../generateText.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a mock LLM response that mimics a successful plan generation.
 * The model returns a JSON plan with the given steps.
 */
function makePlanResponse(steps: Array<{ description: string; tool: string | null; reasoning: string }>) {
  return {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify({ steps }),
        },
        finishReason: 'stop',
      },
    ],
  };
}

/**
 * Returns a mock LLM response with a text-only reply (no tool calls).
 */
function makeTextResponse(text: string) {
  return {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    choices: [
      {
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      },
    ],
  };
}

/**
 * Returns a mock LLM response that requests a tool call.
 */
function makeToolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finishReason: 'tool_calls',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateText — planning integration', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
  });

  // -----------------------------------------------------------------------
  // 1. Planning disabled — no planning call
  // -----------------------------------------------------------------------
  it('does NOT make a planning call when planning is disabled (default)', async () => {
    hoisted.generateCompletion.mockResolvedValueOnce(
      makeTextResponse('Just a normal reply.'),
    );

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Say hello.',
    });

    // Only one call: the normal generation call — no planning call.
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Just a normal reply.');
    expect(result.plan).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 2. Planning enabled — plan call + tool loop
  // -----------------------------------------------------------------------
  it('makes a planning call then executes the tool loop when planning is enabled', async () => {
    const planSteps = [
      { description: 'Look up the weather', tool: 'get_weather', reasoning: 'Need current data' },
      { description: 'Summarise findings', tool: null, reasoning: 'Compose final answer' },
    ];

    // Call 1: planning call returns a plan
    hoisted.generateCompletion.mockResolvedValueOnce(makePlanResponse(planSteps));
    // Call 2: tool loop — model requests a tool call
    hoisted.generateCompletion.mockResolvedValueOnce(
      makeToolCallResponse('get_weather', { city: 'London' }),
    );
    // Call 3: tool loop — model provides final answer after tool result
    hoisted.generateCompletion.mockResolvedValueOnce(
      makeTextResponse('The weather in London is sunny.'),
    );

    const mockTool = {
      name: 'get_weather',
      description: 'Get weather for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      execute: vi.fn(async () => ({ success: true, output: { temp: 22, condition: 'sunny' } })),
    };

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'What is the weather in London?',
      planning: true,
      maxSteps: 5,
      tools: { get_weather: mockTool } as any,
    });

    // 3 calls total: 1 planning + 2 tool loop steps
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(3);

    // The planning call should have a system prompt about planning
    const planningCallMessages = hoisted.generateCompletion.mock.calls[0][1];
    expect(planningCallMessages[0].content).toContain('planning');

    // The second call (first tool loop step) should include the plan
    const toolLoopCallMessages = hoisted.generateCompletion.mock.calls[1][1];
    const systemMessages = toolLoopCallMessages.filter(
      (m: any) => m.role === 'system',
    );
    const planSystemMessage = systemMessages.find((m: any) =>
      String(m.content).includes('Follow this plan'),
    );
    expect(planSystemMessage).toBeDefined();
    expect(planSystemMessage.content).toContain('Look up the weather');
    expect(planSystemMessage.content).toContain('[tool: get_weather]');

    // Result includes the plan
    expect(result.plan).toBeDefined();
    expect(result.plan!.steps).toHaveLength(2);
    expect(result.plan!.steps[0].description).toBe('Look up the weather');
    expect(result.plan!.steps[0].tool).toBe('get_weather');
    expect(result.plan!.steps[1].tool).toBeNull();

    // Tool was actually called
    expect(mockTool.execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('The weather in London is sunny.');

    // Usage includes both planning and tool loop tokens
    expect(result.usage.promptTokens).toBe(20 + 10 + 10);
    expect(result.usage.completionTokens).toBe(30 + 8 + 5);
  });

  // -----------------------------------------------------------------------
  // 3. Planning with custom config
  // -----------------------------------------------------------------------
  it('forwards custom PlanningConfig to the planning call', async () => {
    const customSystemPrompt = 'You are a meticulous planner. Output JSON only.';
    const planSteps = [
      { description: 'Analyse input', tool: null, reasoning: 'Understand the request' },
    ];

    // Call 1: planning call
    hoisted.generateCompletion.mockResolvedValueOnce(makePlanResponse(planSteps));
    // Call 2: final answer
    hoisted.generateCompletion.mockResolvedValueOnce(
      makeTextResponse('Analysis complete.'),
    );

    const result = await generateText({
      model: 'openai:gpt-4.1-mini',
      prompt: 'Analyse this data.',
      planning: {
        systemPrompt: customSystemPrompt,
        temperature: 0.1,
        maxTokens: 512,
      },
    });

    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);

    // Verify planning call used custom config
    const planningCallMessages = hoisted.generateCompletion.mock.calls[0][1];
    expect(planningCallMessages[0].content).toBe(customSystemPrompt);

    const planningCallOptions = hoisted.generateCompletion.mock.calls[0][2];
    expect(planningCallOptions.temperature).toBe(0.1);
    expect(planningCallOptions.maxTokens).toBe(512);

    // Plan is present in result
    expect(result.plan).toBeDefined();
    expect(result.plan!.steps).toHaveLength(1);
    expect(result.plan!.steps[0].description).toBe('Analyse input');
    expect(result.text).toBe('Analysis complete.');
  });
});

describe('generateText planning and the transcript delta', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
  });

  it('keeps the plan and the caller history out of the transcript delta', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(makePlanResponse([{ description: 'Answer', tool: null, reasoning: 'direct' }]))
      .mockResolvedValueOnce(makeTextResponse('Done.'));

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'user', content: 'Earlier question.' },
        { role: 'assistant', content: 'Earlier answer.' },
      ],
      prompt: 'Do it.',
      planning: true,
    });

    expect(result.text).toBe('Done.');
    expect(result.transcriptDelta).toEqual([
      { role: 'user', content: 'Do it.' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});
