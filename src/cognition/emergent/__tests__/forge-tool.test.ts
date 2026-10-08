/**
 * @fileoverview Tests for ForgeToolMetaTool.
 *
 * Covers:
 *  1. Has correct id, name, category, hasSideEffects
 *  2. execute() delegates to engine.forge()
 *  3. Returns success with toolId when approved
 *  4. Returns failure with error when rejected
 *  5. Extracts gmiId and correlationId from context
 *  6. Falls back to 'unknown' when context fields are missing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeToolMetaTool } from '../ForgeToolMetaTool.js';
import type { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import type { ForgeResult } from '../types.js';
import type { ForgeToolInput } from '../ForgeToolMetaTool.js';
import type { ToolExecutionContext } from '../../../core/tools/ITool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ToolExecutionContext. */
function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    gmiId: 'agent-99',
    personaId: 'persona-main',
    userContext: { userId: 'user-1' } as any,
    correlationId: 'sess-xyz',
    ...overrides,
  };
}

/** Build a minimal ForgeToolInput for testing. */
function makeInput(overrides?: Partial<ForgeToolInput>): ForgeToolInput {
  return {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return { sum: input.a + input.b }; }',
      allowlist: [],
    },
    testCases: [{ input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } }],
    ...overrides,
  };
}

/** Build a successful ForgeResult. */
function successResult(): ForgeResult {
  return {
    success: true,
    toolId: 'emergent_12345_abc',
    tool: {
      id: 'emergent_12345_abc',
      name: 'add_numbers',
      description: 'Add two numbers.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      implementation: { mode: 'sandbox', code: '...', allowlist: [] },
      tier: 'session',
      createdBy: 'agent-99',
      createdAt: new Date().toISOString(),
      judgeVerdicts: [],
      usageStats: {
        totalUses: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTimeMs: 0,
        lastUsedAt: null,
        confidenceScore: 0.95,
      },
      source: 'forged by agent agent-99 during session sess-xyz',
    },
    verdict: {
      approved: true,
      confidence: 0.95,
      safety: 1,
      correctness: 1,
      determinism: 1,
      bounded: 1,
      reasoning: 'All good.',
    },
  };
}

/** Build a failure ForgeResult. */
function failureResult(): ForgeResult {
  return {
    success: false,
    verdict: {
      approved: false,
      confidence: 0.3,
      safety: 0,
      correctness: 1,
      determinism: 1,
      bounded: 1,
      reasoning: 'Unsafe patterns found.',
    },
    error: 'Unsafe patterns found.',
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ForgeToolMetaTool', () => {
  let mockEngine: { forge: ReturnType<typeof vi.fn> };
  let metaTool: ForgeToolMetaTool;

  beforeEach(() => {
    mockEngine = {
      forge: vi.fn(),
    };
    metaTool = new ForgeToolMetaTool(mockEngine as unknown as EmergentCapabilityEngine);
  });

  // =========================================================================
  // 1. Identity fields
  // =========================================================================

  it('has correct id, name, category, and hasSideEffects', () => {
    expect(metaTool.id).toBe('com.framers.emergent.forge-tool');
    expect(metaTool.name).toBe('forge_tool');
    expect(metaTool.displayName).toBe('Forge Tool');
    expect(metaTool.category).toBe('emergent');
    expect(metaTool.hasSideEffects).toBe(true);
  });

  it('has a description that mentions compose and sandbox', () => {
    expect(metaTool.description).toContain('compose');
    expect(metaTool.description).toContain('sandbox');
  });

  it('has a valid inputSchema with required fields', () => {
    const schema = metaTool.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('name');
    expect(schema.required).toContain('description');
    expect(schema.required).toContain('inputSchema');
    expect(schema.required).toContain('implementation');
    expect(schema.required).toContain('testCases');
  });

  // =========================================================================
  // 2. execute() delegates to engine.forge()
  // =========================================================================

  it('execute() delegates to engine.forge() with correct arguments', async () => {
    mockEngine.forge.mockResolvedValueOnce(successResult());

    const input = makeInput();
    const ctx = makeContext();

    await metaTool.execute(input, ctx);

    expect(mockEngine.forge).toHaveBeenCalledTimes(1);
    expect(mockEngine.forge).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ agentId: 'persona-main', sessionId: 'sess-xyz' }),
    );
  });

  // =========================================================================
  // 3. Returns success with toolId when approved
  // =========================================================================

  it('returns success with toolId when engine approves', async () => {
    mockEngine.forge.mockResolvedValueOnce(successResult());

    const result = await metaTool.execute(makeInput(), makeContext());

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output!.success).toBe(true);
    expect(result.output!.toolId).toBe('emergent_12345_abc');
    expect(result.output!.tool).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  // =========================================================================
  // 4. Returns failure with error when rejected
  // =========================================================================

  it('returns failure with error when engine rejects', async () => {
    mockEngine.forge.mockResolvedValueOnce(failureResult());

    const result = await metaTool.execute(makeInput(), makeContext());

    expect(result.success).toBe(false);
    expect(result.output).toBeDefined();
    expect(result.output!.success).toBe(false);
    expect(result.error).toBe('Unsafe patterns found.');
  });

  // =========================================================================
  // 5. Extracts gmiId and correlationId from context
  // =========================================================================

  it('passes personaId as agentId and correlationId as sessionId', async () => {
    mockEngine.forge.mockResolvedValueOnce(successResult());

    const ctx = makeContext({ personaId: 'custom-agent', correlationId: 'custom-sess' });
    await metaTool.execute(makeInput(), ctx);

    expect(mockEngine.forge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: 'custom-agent', sessionId: 'custom-sess' }),
    );
  });

  // =========================================================================
  // 6. Falls back to 'unknown' when context fields are missing
  // =========================================================================

  it('falls back to "unknown" when personaId and correlationId are nullish', async () => {
    mockEngine.forge.mockResolvedValueOnce(successResult());

    // Uses ?? (nullish coalescing), so null/undefined map to 'unknown'
    // but empty string '' passes through because it's not nullish.
    const ctx = {
      gmiId: 'agent-99',
      personaId: undefined as unknown as string,
      userContext: { userId: 'user-1' },
    } as ToolExecutionContext;

    await metaTool.execute(makeInput(), ctx);

    expect(mockEngine.forge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: 'unknown', sessionId: 'unknown' }),
    );
  });

  it('preserves an empty personaId instead of replacing it with "unknown"', async () => {
    mockEngine.forge.mockResolvedValueOnce(successResult());

    // Empty string is not nullish — ?? preserves it, unlike || which would
    // replace it with 'unknown'. This is intentional: an explicit empty
    // string assignment is different from a missing/undefined field.
    const ctx = {
      gmiId: 'agent-99',
      personaId: '',
      userContext: { userId: 'user-1' },
    } as ToolExecutionContext;

    await metaTool.execute(makeInput(), ctx);

    expect(mockEngine.forge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: '', sessionId: 'unknown' }),
    );
  });

  // =========================================================================
  // 7. Input validation — missing required fields
  // =========================================================================

  it('returns error when name is missing', async () => {
    const input = makeInput({ name: '' as any });
    const result = await metaTool.execute(input, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('name is required');
    // Engine.forge should NOT have been called.
    expect(mockEngine.forge).not.toHaveBeenCalled();
  });

  it('returns error when description is missing', async () => {
    const input = makeInput({ description: undefined as any });
    const result = await metaTool.execute(input, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('description is required');
    expect(mockEngine.forge).not.toHaveBeenCalled();
  });
});
