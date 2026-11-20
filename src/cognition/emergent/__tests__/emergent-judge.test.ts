/**
 * @fileoverview Tests for EmergentJudge.
 *
 * Covers:
 *  1. reviewCreation() approves when LLM returns all-passed verdict
 *  2. reviewCreation() rejects when LLM says safety failed
 *  3. reviewCreation() rejects when LLM says correctness failed
 *  4. reviewCreation() handles malformed LLM JSON gracefully (returns rejected)
 *  5. reviewCreation() includes source code and test results in prompt
 *  6. validateReuse() passes when output matches schema type 'object'
 *  7. validateReuse() passes when output matches schema type 'string'
 *  8. validateReuse() fails when output type mismatches schema
 *  9. validateReuse() fails when required properties missing
 * 10. reviewPromotion() approves when both judges approve
 * 11. reviewPromotion() rejects when safety judge rejects
 * 12. reviewPromotion() rejects when correctness judge rejects
 * 13. reviewPromotion() makes two separate LLM calls (verify mock called twice)
 * 14. reviewCreationWithDetail() keeps the reply's own fields, names a failed call and an unparsable reply, and
 *     returns reviewCreation()'s verdict
 * 15. judgeAuthor() names the configured model and provider
 * 16. the creation prompt writes a test output JSON.stringify refuses as markers instead of throwing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmergentJudge } from '../EmergentJudge.js';
import type { ToolCandidate } from '../EmergentJudge.js';
import type { EmergentTool } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ToolCandidate for creation review tests.
 * Override any field by passing a partial override object.
 */
function makeCandidate(overrides?: Partial<ToolCandidate>): ToolCandidate {
  return {
    name: 'add_numbers',
    description: 'Adds two numbers together.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sum: { type: 'number' },
      },
    },
    source: 'function execute(input) { return { sum: input.a + input.b }; }',
    implementationMode: 'sandbox',
    allowlist: [],
    testResults: [
      { input: { a: 2, b: 3 }, output: { sum: 5 }, success: true },
      { input: { a: 0, b: 0 }, output: { sum: 0 }, success: true },
    ],
    ...overrides,
  };
}

/**
 * Build a minimal EmergentTool for promotion review tests.
 */
function makeTool(overrides?: Partial<EmergentTool>): EmergentTool {
  return {
    id: 'emergent:test-001',
    name: 'add_numbers',
    description: 'Adds two numbers together.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
    },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return { sum: input.a + input.b }; }',
      allowlist: [],
    },
    tier: 'session',
    createdBy: 'agent-42',
    createdAt: new Date().toISOString(),
    judgeVerdicts: [],
    usageStats: {
      totalUses: 10,
      successCount: 9,
      failureCount: 1,
      avgExecutionTimeMs: 12,
      lastUsedAt: new Date().toISOString(),
      confidenceScore: 0.9,
    },
    source: 'forged by agent-42 during session sess-abc',
    ...overrides,
  };
}

/**
 * Build a JSON string that mimics a successful creation review LLM response.
 */
function approvedCreationResponse(): string {
  return JSON.stringify({
    safety: { passed: true, concerns: [] },
    correctness: { passed: true, failedTests: [] },
    determinism: { likely: true, reasoning: 'Pure arithmetic, fully deterministic.' },
    bounded: { likely: true, reasoning: 'Single addition, O(1) time and space.' },
    confidence: 0.95,
    approved: true,
    reasoning: 'Simple arithmetic tool. No security concerns.',
  });
}

/**
 * Build a JSON string for a creation review where safety failed.
 */
function safetyFailedResponse(): string {
  return JSON.stringify({
    safety: { passed: false, concerns: ['Accesses network without allowlist.'] },
    correctness: { passed: true, failedTests: [] },
    determinism: { likely: true, reasoning: 'Deterministic.' },
    bounded: { likely: true, reasoning: 'Bounded.' },
    confidence: 0.8,
    approved: false,
    reasoning: 'Tool accesses network APIs not declared in allowlist.',
  });
}

/**
 * Build a JSON string for a creation review where correctness failed.
 */
function correctnessFailedResponse(): string {
  return JSON.stringify({
    safety: { passed: true, concerns: [] },
    correctness: { passed: false, failedTests: [1] },
    determinism: { likely: true, reasoning: 'Deterministic.' },
    bounded: { likely: true, reasoning: 'Bounded.' },
    confidence: 0.7,
    approved: false,
    reasoning: 'Test case 1 produced incorrect output.',
  });
}

/**
 * Build a JSON string for a promotion reviewer that approves.
 */
function approvedPromotionResponse(): string {
  return JSON.stringify({
    approved: true,
    confidence: 0.9,
    reasoning: 'Tool is safe and correct.',
  });
}

/**
 * Build a JSON string for a promotion reviewer that rejects.
 */
function rejectedPromotionResponse(): string {
  return JSON.stringify({
    approved: false,
    confidence: 0.6,
    reasoning: 'Concerns about resource usage patterns.',
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EmergentJudge', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let generateText: any;
  let judge: EmergentJudge;

  beforeEach(() => {
    generateText = vi.fn();
    judge = new EmergentJudge({
      judgeModel: 'gpt-4o-mini',
      promotionModel: 'gpt-4o',
      generateText,
    });
  });

  // =========================================================================
  // reviewCreation
  // =========================================================================

  describe('reviewCreation()', () => {
    it('approves when LLM returns all-passed verdict', async () => {
      generateText.mockResolvedValueOnce(approvedCreationResponse());

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(true);
      expect(verdict.confidence).toBe(0.95);
      expect(verdict.safety).toBe(1.0);
      expect(verdict.correctness).toBe(1.0);
      expect(verdict.determinism).toBe(1.0);
      expect(verdict.bounded).toBe(1.0);
      expect(verdict.reasoning).toBe('Simple arithmetic tool. No security concerns.');
    });

    it('rejects when LLM says safety failed', async () => {
      generateText.mockResolvedValueOnce(safetyFailedResponse());

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(false);
      expect(verdict.safety).toBe(0.0);
      expect(verdict.correctness).toBe(1.0);
      expect(verdict.reasoning).toContain('network APIs');
    });

    it('rejects when LLM says correctness failed', async () => {
      generateText.mockResolvedValueOnce(correctnessFailedResponse());

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(false);
      expect(verdict.safety).toBe(1.0);
      expect(verdict.correctness).toBe(0.0);
      expect(verdict.reasoning).toContain('incorrect output');
    });

    it('handles malformed LLM JSON gracefully (returns rejected)', async () => {
      generateText.mockResolvedValueOnce('This is not valid JSON at all!');

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(false);
      expect(verdict.confidence).toBe(0);
      expect(verdict.reasoning).toContain('Failed to parse');
    });

    it('rubric explicitly forbids the "cannot confidently verify" hedge + author-expectation false-rejects', async () => {
      // Regression for the false-reject pattern observed in production:
      // judges were returning approved=false with reasoning that hedged
      // ("cannot confidently verify") or rejected because the author's
      // declared expectedOutput differed from the code's actual output
      // even when the actual output conformed to the schema. The
      // tightened rubric must explicitly close both loopholes.
      generateText.mockResolvedValueOnce(approvedCreationResponse());
      await judge.reviewCreation(makeCandidate());
      const sentArgs = generateText.mock.calls[0].join(' ');
      // Approval-rule guidance must be present.
      expect(sentArgs).toContain('cannot confidently verify');
      expect(sentArgs).toContain('Cannot-verify is not a violation');
      // expectedOutput-vs-actual guidance must be present.
      expect(sentArgs).toContain("expectedOutput");
      expect(sentArgs).toContain('the code is the source of truth');
      // Stylistic-rejection guidance must be present.
      expect(sentArgs).toContain('try/catch');
    });

    it('includes source code and test results in prompt', async () => {
      generateText.mockResolvedValueOnce(approvedCreationResponse());

      const candidate = makeCandidate({
        source: 'function execute(input) { return { doubled: input.x * 2 }; }',
        testResults: [
          { input: { x: 5 }, output: { doubled: 10 }, success: true },
        ],
      });

      await judge.reviewCreation(candidate);

      // Verify the prompt sent to generateText includes the source and test results.
      expect(generateText).toHaveBeenCalledTimes(1);
      const prompt = generateText.mock.calls[0][1] as string;

      expect(prompt).toContain('function execute(input) { return { doubled: input.x * 2 }; }');
      expect(prompt).toContain('"x":5');
      expect(prompt).toContain('"doubled":10');
      expect(prompt).toContain('success=true');
    });

    it('uses the judgeModel for creation reviews', async () => {
      generateText.mockResolvedValueOnce(approvedCreationResponse());

      await judge.reviewCreation(makeCandidate());

      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0][0]).toBe('gpt-4o-mini');
    });

    it('rejects when LLM call throws', async () => {
      generateText.mockRejectedValueOnce(new Error('network error'));

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(false);
      expect(verdict.confidence).toBe(0);
      expect(verdict.reasoning).toContain('LLM call failed');
    });

    it('extracts JSON from markdown code fences', async () => {
      const wrapped = '```json\n' + approvedCreationResponse() + '\n```';
      generateText.mockResolvedValueOnce(wrapped);

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(true);
      expect(verdict.confidence).toBe(0.95);
    });
  });

  // =========================================================================
  // validateReuse
  // =========================================================================

  describe('validateReuse()', () => {
    it('passes when output matches schema type "object"', () => {
      const schema = {
        type: 'object',
        properties: { sum: { type: 'number' } },
      };
      const output = { sum: 42 };

      const verdict = judge.validateReuse('tool-1', output, schema);

      expect(verdict.valid).toBe(true);
      expect(verdict.schemaErrors).toEqual([]);
      expect(verdict.anomaly).toBe(false);
    });

    it('passes when output matches schema type "string"', () => {
      const schema = { type: 'string' };
      const output = 'hello world';

      const verdict = judge.validateReuse('tool-1', output, schema);

      expect(verdict.valid).toBe(true);
      expect(verdict.schemaErrors).toEqual([]);
    });

    it('fails when output type mismatches schema', () => {
      const schema = { type: 'string' };
      const output = 42;

      const verdict = judge.validateReuse('tool-1', output, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors.length).toBeGreaterThan(0);
      expect(verdict.schemaErrors[0]).toContain('Expected type "string"');
      expect(verdict.schemaErrors[0]).toContain('number');
    });

    it('fails when required properties missing', () => {
      const schema = {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      };
      const output = { a: 1 }; // missing 'b'

      const verdict = judge.validateReuse('tool-1', output, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors).toContain('Missing required property "b".');
    });

    it('passes for schema type "number"', () => {
      const schema = { type: 'number' };
      const verdict = judge.validateReuse('tool-1', 3.14, schema);

      expect(verdict.valid).toBe(true);
      expect(verdict.schemaErrors).toEqual([]);
    });

    it('fails for schema type "number" when output is string', () => {
      const schema = { type: 'number' };
      const verdict = judge.validateReuse('tool-1', 'not a number', schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('Expected type "number"');
    });

    it('passes for schema type "boolean"', () => {
      const schema = { type: 'boolean' };
      const verdict = judge.validateReuse('tool-1', true, schema);

      expect(verdict.valid).toBe(true);
    });

    it('passes for schema type "array"', () => {
      const schema = { type: 'array' };
      const verdict = judge.validateReuse('tool-1', [1, 2, 3], schema);

      expect(verdict.valid).toBe(true);
    });

    it('fails for schema type "array" when output is object', () => {
      const schema = { type: 'array' };
      const verdict = judge.validateReuse('tool-1', { a: 1 }, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('Expected type "array"');
    });

    it('fails for schema type "object" when output is null', () => {
      const schema = { type: 'object' };
      const verdict = judge.validateReuse('tool-1', null, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('Expected type "object"');
    });

    it('reports missing declared properties as errors', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      };
      const output = { x: 1 }; // missing 'y'

      const verdict = judge.validateReuse('tool-1', output, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors).toContain('Missing property "y" declared in schema.');
    });
  });

  // =========================================================================
  // reviewPromotion
  // =========================================================================

  describe('reviewPromotion()', () => {
    it('approves when both judges approve', async () => {
      generateText
        .mockResolvedValueOnce(approvedPromotionResponse())
        .mockResolvedValueOnce(approvedPromotionResponse());

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(true);
      expect(verdict.safetyAuditor.approved).toBe(true);
      expect(verdict.correctnessReviewer.approved).toBe(true);
      expect(verdict.confidence).toBe(0.9);
    });

    it('rejects when safety judge rejects', async () => {
      generateText
        .mockResolvedValueOnce(rejectedPromotionResponse())
        .mockResolvedValueOnce(approvedPromotionResponse());

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(false);
      expect(verdict.safetyAuditor.approved).toBe(false);
      expect(verdict.correctnessReviewer.approved).toBe(true);
    });

    it('rejects when correctness judge rejects', async () => {
      generateText
        .mockResolvedValueOnce(approvedPromotionResponse())
        .mockResolvedValueOnce(rejectedPromotionResponse());

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(false);
      expect(verdict.safetyAuditor.approved).toBe(true);
      expect(verdict.correctnessReviewer.approved).toBe(false);
    });

    it('makes two separate LLM calls (verify mock called twice)', async () => {
      generateText
        .mockResolvedValueOnce(approvedPromotionResponse())
        .mockResolvedValueOnce(approvedPromotionResponse());

      await judge.reviewPromotion(makeTool());

      expect(generateText).toHaveBeenCalledTimes(2);

      // Both calls should use the promotion model.
      expect(generateText.mock.calls[0][0]).toBe('gpt-4o');
      expect(generateText.mock.calls[1][0]).toBe('gpt-4o');

      // The two prompts should be different (safety vs correctness).
      const prompt1 = generateText.mock.calls[0][1] as string;
      const prompt2 = generateText.mock.calls[1][1] as string;
      expect(prompt1).not.toBe(prompt2);
      expect(prompt1).toContain('security auditor');
      expect(prompt2).toContain('correctness reviewer');
    });

    it('rejects when both LLM calls return malformed JSON', async () => {
      generateText
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce('also not json');

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(false);
      expect(verdict.safetyAuditor.approved).toBe(false);
      expect(verdict.correctnessReviewer.approved).toBe(false);
      expect(verdict.confidence).toBe(0);
    });

    it('rejects when LLM calls throw errors', async () => {
      generateText
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'));

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(false);
      expect(verdict.safetyAuditor.approved).toBe(false);
      expect(verdict.correctnessReviewer.approved).toBe(false);
    });

    it('computes combined confidence as minimum of both sub-scores', async () => {
      generateText
        .mockResolvedValueOnce(JSON.stringify({ approved: true, confidence: 0.95, reasoning: 'Safe.' }))
        .mockResolvedValueOnce(JSON.stringify({ approved: true, confidence: 0.75, reasoning: 'Correct.' }));

      const verdict = await judge.reviewPromotion(makeTool());

      expect(verdict.approved).toBe(true);
      expect(verdict.confidence).toBe(0.75); // min(0.95, 0.75)
    });
  });

  // =========================================================================
  // reviewCreation — LLM score preservation
  // =========================================================================

  describe('reviewCreation() — LLM score preservation', () => {
    it('uses granular safety score from LLM when provided', async () => {
      // LLM returns a numeric score on the safety object instead of just passed/failed.
      generateText.mockResolvedValueOnce(JSON.stringify({
        safety: { passed: true, score: 0.85, concerns: [] },
        correctness: { passed: true, score: 0.92, failedTests: [] },
        determinism: { likely: true, reasoning: 'Deterministic.' },
        bounded: { likely: true, reasoning: 'Bounded.' },
        confidence: 0.9,
        approved: true,
        reasoning: 'Good tool with granular scores.',
      }));

      const verdict = await judge.reviewCreation(makeCandidate());

      expect(verdict.approved).toBe(true);
      // Should use the granular score, not binary 1.0.
      expect(verdict.safety).toBe(0.85);
      expect(verdict.correctness).toBe(0.92);
    });

    it('rejects when LLM returns { safety: { score: 0.3 } } without passed field', async () => {
      // Missing `passed` field means safetyPassed defaults to false.
      generateText.mockResolvedValueOnce(JSON.stringify({
        safety: { score: 0.3, concerns: ['Suspicious patterns.'] },
        correctness: { passed: true, failedTests: [] },
        determinism: { likely: true, reasoning: 'Deterministic.' },
        bounded: { likely: true, reasoning: 'Bounded.' },
        confidence: 0.5,
        approved: false,
        reasoning: 'Safety concerns.',
      }));

      const verdict = await judge.reviewCreation(makeCandidate());

      // Not approved because safety.passed is not explicitly true.
      expect(verdict.approved).toBe(false);
      // Should preserve the numeric score from the LLM.
      expect(verdict.safety).toBe(0.3);
    });

    it('rejects when LLM returns empty object {}', async () => {
      generateText.mockResolvedValueOnce(JSON.stringify({}));

      const verdict = await judge.reviewCreation(makeCandidate());

      // Empty object means safety.passed and correctness.passed are both
      // undefined, so the tool must not be approved.
      expect(verdict.approved).toBe(false);
      expect(verdict.safety).toBe(0.0);
      expect(verdict.correctness).toBe(0.0);
      expect(verdict.confidence).toBe(0);
    });

    it('rejects when LLM returns { confidence: "not a number" }', async () => {
      generateText.mockResolvedValueOnce(JSON.stringify({
        safety: { passed: true, concerns: [] },
        correctness: { passed: true, failedTests: [] },
        determinism: { likely: true, reasoning: 'Ok.' },
        bounded: { likely: true, reasoning: 'Ok.' },
        confidence: 'not a number',
        approved: true,
        reasoning: 'Should still work.',
      }));

      const verdict = await judge.reviewCreation(makeCandidate());

      // The tool should still be approved (safety + correctness both pass).
      expect(verdict.approved).toBe(true);
      // But confidence should fall back to 0 because it's not a number.
      expect(verdict.confidence).toBe(0);
    });
  });

  // =========================================================================
  // reviewCreationWithDetail, judgeAuthor and the prompt's test outputs
  // =========================================================================

  describe('reviewCreationWithDetail()', () => {
    /** A reply whose own fields the verdict drops or recomputes: its approved, the concerns, the failed tests. */
    const MIXED_REPLY = JSON.stringify({
      safety: { passed: false, concerns: ['Reads the clock.'] },
      correctness: { passed: true, failedTests: [2] },
      determinism: { likely: false, reasoning: 'Uses Date.' },
      bounded: { likely: true, reasoning: 'One loop.' },
      confidence: 0.4,
      approved: true,
      reasoning: 'Mixed.',
    });

    it("reviewCreationWithDetail keeps the reply's own fields that the verdict drops", async () => {
      generateText.mockResolvedValueOnce(MIXED_REPLY);

      const { verdict, detail } = await judge.reviewCreationWithDetail(makeCandidate());

      expect(generateText).toHaveBeenCalledTimes(1);
      expect(verdict).toEqual({
        approved: false,
        confidence: 0.4,
        safety: 0,
        correctness: 1,
        determinism: 0.5,
        bounded: 1,
        reasoning: 'Mixed.',
      });
      expect(detail).toEqual({
        judgeModel: 'gpt-4o-mini',
        replyParsed: true,
        judgeError: null,
        judgeApproved: true,
        safetyPassed: false,
        safetyConcerns: ['Reads the clock.'],
        correctnessPassed: true,
        failedTests: [2],
        deterministic: false,
        determinismReasoning: 'Uses Date.',
        bounded: true,
        boundedReasoning: 'One loop.',
      });
    });

    it('reviewCreationWithDetail names a failed call and an unparsable reply', async () => {
      const unread = {
        judgeModel: 'gpt-4o-mini',
        replyParsed: false,
        judgeApproved: null,
        safetyPassed: null,
        safetyConcerns: [],
        correctnessPassed: null,
        failedTests: [],
        deterministic: null,
        determinismReasoning: null,
        bounded: null,
        boundedReasoning: null,
      };

      generateText.mockRejectedValueOnce(new Error('provider down'));
      const failed = await judge.reviewCreationWithDetail(makeCandidate());
      expect(failed.detail).toEqual({ ...unread, judgeError: 'llm_call_failed' });
      expect(failed.verdict.reasoning).toBe('LLM call failed during creation review.');
      expect(JSON.stringify(failed)).not.toContain('provider down');

      generateText.mockResolvedValueOnce('not json, a sentence instead');
      const unparsable = await judge.reviewCreationWithDetail(makeCandidate());
      expect(unparsable.detail).toEqual({ ...unread, judgeError: 'reply_unparsable' });
      expect(JSON.stringify(unparsable)).not.toContain('a sentence instead');
    });

    it("its verdicts equal reviewCreation's for the same replies", async () => {
      const replies: Array<string | Error> = [
        new Error('provider down'),
        'not json',
        MIXED_REPLY,
        approvedCreationResponse(),
        safetyFailedResponse(),
        JSON.stringify({}),
      ];
      for (const reply of replies) {
        for (let call = 0; call < 2; call += 1) {
          if (reply instanceof Error) {
            generateText.mockRejectedValueOnce(reply);
          } else {
            generateText.mockResolvedValueOnce(reply);
          }
        }
        const withDetail = await judge.reviewCreationWithDetail(makeCandidate());
        const alone = await judge.reviewCreation(makeCandidate());
        expect(withDetail.verdict).toEqual(alone);
      }
      expect(generateText).toHaveBeenCalledTimes(replies.length * 2);
    });

    it('the detail writes a non-string as JSON text and keeps only numbers in failedTests', async () => {
      // Written as text: 1e400 parses to Infinity, which is not a finite number.
      generateText.mockResolvedValueOnce(
        '{"safety":{"passed":true,"concerns":[{"api":"fs"},7,null,"Plain words."]},' +
          '"correctness":{"passed":true,"failedTests":[1,"two",3,1e400,null]},' +
          '"determinism":{"likely":true,"reasoning":7},"bounded":{"likely":"yes"},' +
          '"confidence":0.9,"approved":"yes","reasoning":"Ok."}',
      );

      const { detail } = await judge.reviewCreationWithDetail(makeCandidate());

      expect(detail.determinismReasoning).toBe('7');
      expect(detail.failedTests).toEqual([1, 3]);
      expect(detail.safetyConcerns).toEqual(['{"api":"fs"}', '7', 'null', 'Plain words.']);
      expect(detail.deterministic).toBe(true);
      // Not booleans in the reply, so not booleans in the detail; an absent reasoning is null.
      expect(detail.bounded).toBeNull();
      expect(detail.boundedReasoning).toBeNull();
      expect(detail.judgeApproved).toBeNull();
    });
  });

  describe('judgeAuthor()', () => {
    it('judgeAuthor names the configured model and provider', () => {
      expect(judge.judgeAuthor()).toEqual({ model: 'gpt-4o-mini', providerId: null });

      const named = new EmergentJudge({
        judgeModel: 'judge-model',
        promotionModel: 'promotion-model',
        generateText,
        providerId: 'judge-provider',
      });
      expect(named.judgeAuthor()).toEqual({ model: 'judge-model', providerId: 'judge-provider' });
    });
  });

  describe('the creation prompt and its test outputs', () => {
    it('the prompt writes a BigInt and a cycle in a test output as markers instead of throwing', async () => {
      generateText.mockResolvedValueOnce(approvedCreationResponse());
      const output: Record<string, unknown> = { big: 10n };
      output.self = output;

      const verdict = await judge.reviewCreation(
        makeCandidate({ testResults: [{ input: { a: 1, b: 2 }, output, success: true }] }),
      );

      expect(verdict.approved).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(1);
      const prompt = generateText.mock.calls[0][1] as string;
      for (const word of ['unserializable', 'bigint', 'cycle']) {
        expect(prompt).toContain(word);
      }
      expect(prompt).toContain(
        'Test 1: input={"a":1,"b":2} output={"big":{"$trace":"unserializable","kind":"bigint"},' +
          '"self":{"$trace":"unserializable","kind":"cycle"}} success=true',
      );
    });

    it('the prompt writes a nested array whose length is a symbol as an other marker, and the judge is asked', async () => {
      generateText.mockResolvedValueOnce(approvedCreationResponse());
      const symbolLength = new Proxy([] as unknown[], {
        get(target, key, receiver) {
          return key === 'length' ? Symbol('length') : Reflect.get(target, key, receiver);
        },
      });
      const output = { list: [symbolLength, 1] };

      const verdict = await judge.reviewCreation(
        makeCandidate({ testResults: [{ input: { a: 1, b: 2 }, output, success: true }] }),
      );

      expect(verdict.approved).toBe(true);
      expect(generateText).toHaveBeenCalledTimes(1);
      const prompt = generateText.mock.calls[0][1] as string;
      expect(prompt).toContain(
        'Test 1: input={"a":1,"b":2} output={"list":[{"$trace":"unserializable","kind":"other"},1]} success=true',
      );
    });
  });

  // =========================================================================
  // validateReuse — full schema validation
  // =========================================================================

  describe('validateReuse() — constraint validation', () => {
    it('rejects string shorter than minLength', () => {
      const schema = { type: 'string', minLength: 5 };
      const verdict = judge.validateReuse('tool-1', 'hi', schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('minLength');
    });

    it('rejects string longer than maxLength', () => {
      const schema = { type: 'string', maxLength: 3 };
      const verdict = judge.validateReuse('tool-1', 'toolong', schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('maxLength');
    });

    it('rejects string not matching pattern', () => {
      const schema = { type: 'string', pattern: '^[a-z]+$' };
      const verdict = judge.validateReuse('tool-1', 'ABC123', schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('pattern');
    });

    it('rejects string not in enum', () => {
      const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
      const verdict = judge.validateReuse('tool-1', 'yellow', schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('enum');
    });

    it('rejects number below minimum', () => {
      const schema = { type: 'number', minimum: 10 };
      const verdict = judge.validateReuse('tool-1', 5, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('minimum');
    });

    it('rejects number above maximum', () => {
      const schema = { type: 'number', maximum: 100 };
      const verdict = judge.validateReuse('tool-1', 150, schema);

      expect(verdict.valid).toBe(false);
      expect(verdict.schemaErrors[0]).toContain('maximum');
    });

    it('validates nested object schema with maxLength constraint', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 10 },
          age: { type: 'number', minimum: 0 },
        },
        required: ['name', 'age'],
      };

      // Name exceeds maxLength.
      const verdict = judge.validateReuse('tool-1', {
        name: 'a very long name that exceeds the limit',
        age: 25,
      }, schema);

      expect(verdict.valid).toBe(false);
      // Error should be prefixed with the property name.
      expect(verdict.schemaErrors.some(e => e.startsWith('name.'))).toBe(true);
      expect(verdict.schemaErrors.some(e => e.includes('maxLength'))).toBe(true);
    });

    it('recursively validates array items', () => {
      const schema = {
        type: 'array',
        items: { type: 'number', minimum: 0 },
      };

      const verdict = judge.validateReuse('tool-1', [1, 2, -3, 4], schema);

      expect(verdict.valid).toBe(false);
      // Error should reference the index.
      expect(verdict.schemaErrors.some(e => e.includes('[2]'))).toBe(true);
      expect(verdict.schemaErrors.some(e => e.includes('minimum'))).toBe(true);
    });

    it('passes valid nested object with constraints', () => {
      const schema = {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 50 },
          count: { type: 'integer', minimum: 0, maximum: 1000 },
        },
        required: ['title', 'count'],
      };

      const verdict = judge.validateReuse('tool-1', {
        title: 'Valid Title',
        count: 42,
      }, schema);

      expect(verdict.valid).toBe(true);
      expect(verdict.schemaErrors).toEqual([]);
    });
  });
});
