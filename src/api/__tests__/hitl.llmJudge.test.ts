/**
 * @file hitl.llmJudge.test.ts
 * @description Unit tests for the `hitl.llmJudge()` handler factory.
 *
 * Covers:
 * 1. Approves when LLM returns approved:true with high confidence.
 * 2. Rejects when LLM returns approved:false.
 * 3. Falls back to custom handler when confidence is below threshold.
 * 4. Falls back to autoReject by default when confidence is low.
 * 5. Handles LLM errors gracefully (delegates to fallback).
 * 6. Passes custom criteria to the system prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hitl } from '../hitl.js';
import type { ApprovalRequest } from '../types.js';

// ---------------------------------------------------------------------------
// Mock generateText — intercepts the lazy dynamic import inside llmJudge.
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();

vi.mock('../generateText.js', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal `ApprovalRequest` suitable for handler invocation. */
function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'req-001',
    type: 'tool',
    agent: 'test-agent',
    action: 'delete-file',
    description: 'Delete /tmp/data.json',
    details: { path: '/tmp/data.json' },
    context: {
      agentCalls: [],
      totalTokens: 0,
      totalCostUSD: 0,
      elapsedMs: 100,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hitl.llmJudge', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  // -------------------------------------------------------------------------
  // 1. Approves when LLM returns approved:true with high confidence
  // -------------------------------------------------------------------------

  it('approves when LLM returns approved:true with high confidence', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.95, "reasoning": "Safe operation" }',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge({ model: 'gpt-4o-mini' });
    const decision = await handler(makeRequest());

    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('Safe operation');
  });

  // -------------------------------------------------------------------------
  // 2. Rejects when LLM returns approved:false
  // -------------------------------------------------------------------------

  it('rejects when LLM returns approved:false with high confidence', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": false, "confidence": 0.9, "reasoning": "Dangerous action" }',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge();
    const decision = await handler(makeRequest());

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('Dangerous action');
  });

  // -------------------------------------------------------------------------
  // 3. Falls back to custom handler when confidence below threshold
  // -------------------------------------------------------------------------

  it('falls back to custom handler when confidence is below threshold', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.4, "reasoning": "Uncertain" }',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const customFallback = vi.fn().mockResolvedValue({
      approved: false,
      reason: 'Escalated to human',
    });

    const handler = hitl.llmJudge({
      confidenceThreshold: 0.8,
      fallback: customFallback,
    });

    const request = makeRequest();
    const decision = await handler(request);

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('Escalated to human');
    expect(customFallback).toHaveBeenCalledWith(request);
  });

  // -------------------------------------------------------------------------
  // 4. Falls back to autoReject by default when confidence is low
  // -------------------------------------------------------------------------

  it('falls back to autoReject by default when confidence is low', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.3, "reasoning": "Maybe" }',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge();
    const decision = await handler(makeRequest());

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('LLM judge confidence too low');
  });

  // -------------------------------------------------------------------------
  // 5. Handles LLM error gracefully (delegates to fallback)
  // -------------------------------------------------------------------------

  it('handles LLM error gracefully and falls back', async () => {
    mockGenerateText.mockRejectedValue(new Error('Provider unavailable'));

    const handler = hitl.llmJudge();
    const decision = await handler(makeRequest());

    // Default fallback is autoReject with the standard message.
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('LLM judge confidence too low');
  });

  // -------------------------------------------------------------------------
  // 6. Passes custom criteria to the system prompt
  // -------------------------------------------------------------------------

  it('passes custom criteria to the system prompt', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.99, "reasoning": "Checks out" }',
      provider: 'openai',
      model: 'gpt-4o-mini',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge({
      criteria: 'Is the response factually accurate and well-sourced?',
    });

    await handler(makeRequest());

    // Verify generateText was called with a system prompt containing the custom criteria.
    expect(mockGenerateText).toHaveBeenCalledOnce();
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.system).toContain('Is the response factually accurate and well-sourced?');
  });
});

describe('judge default resolution (spec batch-1 C3)', () => {
  it('default judge call carries the resolver model, provider, and effort', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.9, "reasoning": "ok" }',
      provider: 'openai',
      model: 'gpt-5.6',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge();
    await handler(makeRequest());

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6', provider: 'openai', effort: 'max' }),
    );
  });

  it('a caller-pinned model gets no injected effort (zero-change)', async () => {
    mockGenerateText.mockResolvedValue({
      text: '{ "approved": true, "confidence": 0.9, "reasoning": "ok" }',
      provider: 'openai',
      model: 'gpt-4o',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      toolCalls: [],
      finishReason: 'stop',
    });

    const handler = hitl.llmJudge({ model: 'gpt-4o' });
    await handler(makeRequest());

    const lastCall = mockGenerateText.mock.calls.at(-1)![0];
    expect(lastCall.model).toBe('gpt-4o');
    expect('effort' in lastCall).toBe(false);
  });
});
