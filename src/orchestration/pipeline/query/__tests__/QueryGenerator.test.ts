/**
 * @fileoverview Tests for QueryGenerator — tier-appropriate prompt construction
 * and LLM answer generation.
 *
 * Validates that the generator selects the correct model, builds the right
 * system prompt (with or without context/research), and returns structured
 * results for each query tier (T0–T3).
 *
 * Mock pattern: `vi.hoisted` + `vi.mock` for `generateText` so the tests
 * never hit a real LLM provider.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { QueryTier, RetrievedChunk } from '../types.js';

// ---------------------------------------------------------------------------
// Mock — hoist the mock factory so it is available before module load
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock('../../../../api/generateText.js', () => ({
  generateText: hoisted.generateText,
}));

import { QueryGenerator } from '../QueryGenerator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal `GenerateTextResult` response. */
function fakeResult(text = 'Test answer') {
  return {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    text,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    toolCalls: [],
    finishReason: 'stop' as const,
  };
}

/** A handful of sample chunks for context injection tests. */
const SAMPLE_CHUNKS: RetrievedChunk[] = [
  {
    id: 'c1',
    content: 'Authentication uses JWT tokens issued by the auth service.',
    heading: 'Auth Flow',
    sourcePath: 'docs/auth.md',
    relevanceScore: 0.92,
    matchType: 'vector',
  },
  {
    id: 'c2',
    content: 'The database stores user profiles and session data.',
    heading: 'Database Schema',
    sourcePath: 'docs/database.md',
    relevanceScore: 0.85,
    matchType: 'vector',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryGenerator', () => {
  let generator: QueryGenerator;

  beforeEach(() => {
    hoisted.generateText.mockReset();
    hoisted.generateText.mockResolvedValue(fakeResult());

    generator = new QueryGenerator({
      model: 'openai:gpt-4.1-mini',
      modelDeep: 'openai:gpt-4.1',
      provider: 'openai',
    });
  });

  // -------------------------------------------------------------------------
  // Test 1: T0 — no context
  // -------------------------------------------------------------------------
  it('generates T0 response with no context', async () => {
    const result = await generator.generate('What is TypeScript?', 0 as QueryTier, []);

    expect(result.answer).toBe('Test answer');
    expect(result.model).toBe('openai:gpt-4.1-mini');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });

    // System prompt must NOT contain "Documentation context"
    const callArgs = hoisted.generateText.mock.calls[0][0];
    expect(callArgs.system).not.toContain('Documentation context');
  });

  // -------------------------------------------------------------------------
  // Test 2: T1 — chunks injected as context
  // -------------------------------------------------------------------------
  it('generates T1 response with chunks as context', async () => {
    const result = await generator.generate('How does auth work?', 1 as QueryTier, SAMPLE_CHUNKS);

    expect(result.answer).toBe('Test answer');

    const callArgs = hoisted.generateText.mock.calls[0][0];
    // System prompt MUST contain the documentation context block
    expect(callArgs.system).toContain('Documentation context');
    // System prompt MUST contain chunk content
    expect(callArgs.system).toContain('Authentication uses JWT tokens');
    expect(callArgs.system).toContain('docs/auth.md');
    // T1 instruction
    expect(callArgs.system).toContain('Answer based on the documentation context provided.');
  });

  // -------------------------------------------------------------------------
  // Test 3: T2+ — deep model
  // -------------------------------------------------------------------------
  it('uses deep model for T2+', async () => {
    hoisted.generateText.mockResolvedValue({
      ...fakeResult(),
      model: 'gpt-4.1',
    });

    const result = await generator.generate(
      'How does auth flow from frontend to backend?',
      2 as QueryTier,
      SAMPLE_CHUNKS,
    );

    const callArgs = hoisted.generateText.mock.calls[0][0];
    // Must use the deep model for T2+
    expect(callArgs.model).toBe('openai:gpt-4.1');
    // T2 instruction about cross-referencing
    expect(callArgs.system).toContain('cross-reference');
  });

  // -------------------------------------------------------------------------
  // Test 4: T3 — research synthesis included
  // -------------------------------------------------------------------------
  it('includes research synthesis for T3', async () => {
    const synthesis = 'External research found that JWT refresh tokens should be rotated every 15 minutes.';

    const result = await generator.generate(
      'Compare all auth strategies and recommend improvements',
      3 as QueryTier,
      SAMPLE_CHUNKS,
      synthesis,
    );

    const callArgs = hoisted.generateText.mock.calls[0][0];
    // Must use deep model
    expect(callArgs.model).toBe('openai:gpt-4.1');
    // System prompt MUST contain the research synthesis
    expect(callArgs.system).toContain('External research');
    expect(callArgs.system).toContain(synthesis);
    // T3 instruction about synthesising
    expect(callArgs.system).toContain('Synthesize information from both internal documentation and external research.');
  });
});
